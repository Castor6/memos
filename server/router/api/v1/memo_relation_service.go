package v1

import (
	"context"
	"fmt"

	"github.com/pkg/errors"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

func (s *APIV1Service) SetMemoRelations(ctx context.Context, request *v1pb.SetMemoRelationsRequest) (*emptypb.Empty, error) {
	_, err := s.UpdateMemo(ctx, &v1pb.UpdateMemoRequest{
		Memo:       &v1pb.Memo{Name: request.Name, Relations: request.Relations},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"relations", "update_time"}},
	})
	if err != nil {
		return nil, err
	}
	return &emptypb.Empty{}, nil
}

func (s *APIV1Service) validateMemoRelations(ctx context.Context, memo *store.Memo, relations []*v1pb.MemoRelation) error {
	_, err := s.prepareMemoRelations(ctx, memo, relations)
	return err
}

func (s *APIV1Service) prepareMemoRelations(ctx context.Context, memo *store.Memo, relations []*v1pb.MemoRelation) ([]*store.MemoRelation, error) {
	prepared := make([]*store.MemoRelation, 0, len(relations))
	for _, relation := range relations {
		if relation == nil || relation.RelatedMemo == nil {
			return nil, status.Errorf(codes.InvalidArgument, "related memo is required")
		}
		if relation.Type == v1pb.MemoRelation_COMMENT {
			continue
		}
		uid, err := ExtractMemoUIDFromName(relation.RelatedMemo.Name)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "invalid related memo")
		}
		target, err := s.Store.GetMemo(ctx, &store.FindMemo{UID: &uid})
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to find related memo")
		}
		if target == nil || target.Space != memo.Space || target.IsTodo || memo.IsTodo {
			return nil, status.Errorf(codes.InvalidArgument, "references must link notes in the same space")
		}
		if err := s.checkMemoReadAccess(ctx, target); err != nil {
			return nil, err
		}
		prepared = append(prepared, &store.MemoRelation{MemoID: memo.ID, RelatedMemoID: target.ID, Type: store.MemoRelationReference})
	}
	return prepared, nil
}

func (s *APIV1Service) setMemoRelationsInternal(ctx context.Context, memo *store.Memo, relations []*v1pb.MemoRelation) error {
	prepared, err := s.prepareMemoRelations(ctx, memo, relations)
	if err != nil {
		return err
	}
	return s.Store.ApplyMemoMutation(ctx, &store.MemoMutation{Update: &store.UpdateMemo{ID: memo.ID}, Relations: &prepared})
}
func (s *APIV1Service) ListMemoRelations(ctx context.Context, request *v1pb.ListMemoRelationsRequest) (*v1pb.ListMemoRelationsResponse, error) {
	memoUID, err := ExtractMemoUIDFromName(request.Name)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid memo name: %v", err)
	}
	memo, err := s.Store.GetMemo(ctx, &store.FindMemo{UID: &memoUID})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get memo")
	}

	if memo == nil {
		return nil, status.Errorf(codes.NotFound, "memo not found")
	}
	currentUser, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get user")
	}
	var memoFilter string
	if currentUser == nil {
		memoFilter = `visibility == "PUBLIC"`
	} else {
		memoFilter = fmt.Sprintf(`creator_id == %d || visibility in ["PUBLIC", "PROTECTED"]`, currentUser.ID)
	}
	relationList := []*v1pb.MemoRelation{}
	tempList, err := s.Store.ListMemoRelations(ctx, &store.FindMemoRelation{
		MemoID:     &memo.ID,
		MemoFilter: &memoFilter,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list memo relations: %v", err)
	}
	for _, raw := range tempList {
		relation, err := s.convertMemoRelationFromStore(ctx, raw)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to convert memo relation")
		}
		relationList = append(relationList, relation)
	}
	tempList, err = s.Store.ListMemoRelations(ctx, &store.FindMemoRelation{
		RelatedMemoID: &memo.ID,
		MemoFilter:    &memoFilter,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list related memo relations: %v", err)
	}
	for _, raw := range tempList {
		relation, err := s.convertMemoRelationFromStore(ctx, raw)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to convert memo relation")
		}
		relationList = append(relationList, relation)
	}

	response := &v1pb.ListMemoRelationsResponse{
		Relations: relationList,
	}
	return response, nil
}

func (s *APIV1Service) convertMemoRelationFromStore(ctx context.Context, memoRelation *store.MemoRelation) (*v1pb.MemoRelation, error) {
	memo, err := s.Store.GetMemo(ctx, &store.FindMemo{ID: &memoRelation.MemoID})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get memo: %v", err)
	}
	memoSnippet, err := s.getMemoContentSnippet(memo.Content)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get memo content snippet")
	}
	relatedMemo, err := s.Store.GetMemo(ctx, &store.FindMemo{ID: &memoRelation.RelatedMemoID})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get related memo: %v", err)
	}
	relatedMemoSnippet, err := s.getMemoContentSnippet(relatedMemo.Content)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get related memo content snippet")
	}
	return &v1pb.MemoRelation{
		Memo: &v1pb.MemoRelation_Memo{
			Name:    fmt.Sprintf("%s%s", MemoNamePrefix, memo.UID),
			Snippet: memoSnippet,
		},
		RelatedMemo: &v1pb.MemoRelation_Memo{
			Name:    fmt.Sprintf("%s%s", MemoNamePrefix, relatedMemo.UID),
			Snippet: relatedMemoSnippet,
		},
		Type: convertMemoRelationTypeFromStore(memoRelation.Type),
	}, nil
}

func convertMemoRelationTypeFromStore(relationType store.MemoRelationType) v1pb.MemoRelation_Type {
	switch relationType {
	case store.MemoRelationReference:
		return v1pb.MemoRelation_REFERENCE
	case store.MemoRelationComment:
		return v1pb.MemoRelation_COMMENT
	default:
		return v1pb.MemoRelation_TYPE_UNSPECIFIED
	}
}

func convertMemoRelationTypeToStore(relationType v1pb.MemoRelation_Type) store.MemoRelationType {
	switch relationType {
	case v1pb.MemoRelation_COMMENT:
		return store.MemoRelationComment
	default:
		return store.MemoRelationReference
	}
}
