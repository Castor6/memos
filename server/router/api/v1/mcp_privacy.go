package v1

import (
	"context"
	"net/url"
	"regexp"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/usememos/memos/internal/mcpaccess"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/server/runner/memopayload"
	"github.com/usememos/memos/store"
)

var mcpResourceReference = regexp.MustCompile(`/(memos|file/attachments)/([A-Za-z0-9_-]+)`)

// sanitizeMCPMemo removes entire Markdown blocks containing protected resource
// references, including cached labels. Ordinary copied prose is not traced.
func (s *APIV1Service) sanitizeMCPMemo(ctx context.Context, memo *store.Memo) (*store.Memo, bool, error) {
	if !mcpaccess.IsRequest(ctx) {
		return memo, false, nil
	}
	blocks := strings.Split(memo.Content, "\n\n")
	changed := false
	for i, block := range blocks {
		decoded, err := url.PathUnescape(block)
		if err != nil {
			decoded = block
		}
		for _, match := range mcpResourceReference.FindAllStringSubmatch(decoded, -1) {
			uid := match[2]
			hidden := false
			if match[1] == "memos" {
				target, err := s.Store.GetMemo(store.WithoutSpace(ctx), &store.FindMemo{UID: &uid})
				if err != nil {
					return nil, false, err
				}
				hidden, err = s.memoHiddenFromMCP(ctx, target)
				if err != nil {
					return nil, false, err
				}
			} else {
				attachment, err := s.Store.GetAttachment(store.WithoutSpace(ctx), &store.FindAttachment{UID: &uid})
				if err != nil {
					return nil, false, err
				}
				if attachment != nil && attachment.MemoID != nil {
					target, err := s.Store.GetMemo(store.WithoutSpace(ctx), &store.FindMemo{ID: attachment.MemoID})
					if err != nil {
						return nil, false, err
					}
					hidden, err = s.memoHiddenFromMCP(ctx, target)
					if err != nil {
						return nil, false, err
					}
				}
			}
			if hidden {
				blocks[i] = "[Content unavailable through MCP]"
				changed = true
				break
			}
		}
	}
	// Immutable capture snapshots may retain references removed from the live body.
	if memo.Payload != nil && memo.Payload.Capture != nil {
		snapshot, err := protojson.Marshal(memo.Payload.Capture)
		if err != nil {
			return nil, false, err
		}
		_, captureChanged, err := s.sanitizeMCPMemo(ctx, &store.Memo{Content: string(snapshot)})
		if err != nil {
			return nil, false, err
		}
		changed = changed || captureChanged
	}
	if !changed {
		return memo, false, nil
	}
	sanitized := *memo
	sanitized.Content = strings.Join(blocks, "\n\n")
	if memo.Payload != nil {
		sanitized.Payload = proto.Clone(memo.Payload).(*storepb.MemoPayload)
		sanitized.Payload.Capture = nil
	}
	if err := memopayload.RebuildMemoPayload(ctx, &sanitized, s.MarkdownService); err != nil {
		return nil, false, err
	}
	return &sanitized, true, nil
}

func (s *APIV1Service) memoHiddenFromMCP(ctx context.Context, memo *store.Memo) (bool, error) {
	seen := make(map[int32]bool)
	for memo != nil {
		if memo.MCPHidden || seen[memo.ID] {
			return true, nil
		}
		seen[memo.ID] = true
		if memo.ParentUID == nil {
			return false, nil
		}
		var err error
		memo, err = s.Store.GetMemo(store.WithoutSpace(ctx), &store.FindMemo{UID: memo.ParentUID})
		if err != nil {
			return false, err
		}
	}
	return false, nil
}

func (s *APIV1Service) checkMCPMemoReplacement(ctx context.Context, memo *store.Memo, paths []string) error {
	if !mcpaccess.IsRequest(ctx) {
		return nil
	}
	for _, path := range paths {
		if path != "content" && path != "relations" && path != "attachments" {
			continue
		}
		_, changed, err := s.sanitizeMCPMemo(ctx, memo)
		if err != nil {
			return status.Errorf(codes.Internal, "failed to check memo references")
		}
		if changed {
			return status.Errorf(codes.FailedPrecondition, "edit this memo in the app because MCP cannot access all of its content")
		}
		if path == "relations" {
			relations, err := s.Store.ListMemoRelations(ctx, &store.FindMemoRelation{MemoID: &memo.ID})
			if err != nil {
				return status.Errorf(codes.Internal, "failed to check memo relations")
			}
			for _, relation := range relations {
				target, err := s.Store.GetMemo(store.WithoutSpace(ctx), &store.FindMemo{ID: &relation.RelatedMemoID})
				if err != nil {
					return status.Errorf(codes.Internal, "failed to check related memo")
				}
				hidden, err := s.memoHiddenFromMCP(ctx, target)
				if err != nil {
					return status.Errorf(codes.Internal, "failed to check related memo")
				}
				if hidden {
					return status.Errorf(codes.FailedPrecondition, "edit this memo's relations in the app")
				}
			}
		}
	}
	return nil
}

// listMCPFilteredMemos scans candidates before pagination so filtered snippets
// cannot produce empty pages or expose whether a protected cached label matched.
func (s *APIV1Service) listMCPFilteredMemos(ctx context.Context, find *store.FindMemo, limit, offset int) ([]*store.Memo, int, error) {
	result := make([]*store.Memo, 0, limit+1)
	batchSize := limit + 1
	for {
		query := *find
		query.Limit, query.Offset = &batchSize, &offset
		batch, err := s.Store.ListMemos(ctx, &query)
		if err != nil {
			return nil, 0, err
		}
		for _, memo := range batch {
			_, changed, err := s.sanitizeMCPMemo(ctx, memo)
			if err != nil {
				return nil, 0, err
			}
			if !changed {
				if len(result) == limit {
					return result, offset, nil
				}
				result = append(result, memo)
			}
			offset++
		}
		if len(batch) < batchSize {
			return result, -1, nil
		}
	}
}

// checkMCPDeleteComments protects independently hidden descendants from cascading deletions.
func (s *APIV1Service) checkMCPDeleteComments(ctx context.Context, memo *store.Memo) error {
	if !mcpaccess.IsRequest(ctx) {
		return nil
	}
	pending := []int32{memo.ID}
	seen := make(map[int32]bool)
	commentType := store.MemoRelationComment
	for len(pending) > 0 {
		id := pending[0]
		pending = pending[1:]
		if seen[id] {
			continue
		}
		seen[id] = true
		comments, err := s.Store.ListMemoRelations(store.WithoutSpace(ctx), &store.FindMemoRelation{RelatedMemoID: &id, Type: &commentType})
		if err != nil {
			return status.Errorf(codes.Internal, "failed to check comments")
		}
		for _, comment := range comments {
			child, err := s.Store.GetMemo(store.WithoutSpace(ctx), &store.FindMemo{ID: &comment.MemoID})
			if err != nil {
				return status.Errorf(codes.Internal, "failed to check comment")
			}
			if child != nil && child.MCPHidden {
				return status.Errorf(codes.FailedPrecondition, "delete this memo in the app because it has protected comments")
			}
			pending = append(pending, comment.MemoID)
		}
	}
	return nil
}
