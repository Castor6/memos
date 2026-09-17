package v1

import (
	"context"
	"strings"
	"unicode/utf8"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/usememos/memos/internal/base"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func (s *APIV1Service) validateSelectedSpace(ctx context.Context, userID int32) (string, error) {
	space, _ := store.SpaceFromContext(ctx)
	if space == "" {
		return "", nil
	}
	setting, err := s.Store.GetUserSetting(ctx, &store.FindUserSetting{UserID: &userID, Key: storepb.UserSetting_GENERAL})
	if err != nil {
		return "", status.Errorf(codes.Internal, "failed to get spaces")
	}
	if setting == nil || setting.GetGeneral().GetSpaces()[space] == "" {
		return "", status.Errorf(codes.InvalidArgument, "unknown personal space")
	}
	return space, nil
}

func validateSpaces(incoming, existing map[string]string) error {
	if len(incoming) > 100 {
		return status.Errorf(codes.InvalidArgument, "too many spaces")
	}
	for id, name := range incoming {
		if !base.UIDMatcher.MatchString(id) || strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 100 {
			return status.Errorf(codes.InvalidArgument, "invalid space")
		}
	}
	for id := range existing {
		if _, ok := incoming[id]; !ok {
			return status.Errorf(codes.InvalidArgument, "spaces containing data cannot be removed")
		}
	}
	return nil
}

func validateExplicitTags(tags []string) error {
	if len(tags) > 100 {
		return status.Errorf(codes.InvalidArgument, "too many tags")
	}
	seen := map[string]bool{}
	for _, tag := range tags {
		if strings.TrimSpace(tag) != tag || tag == "" || len(tag) > 256 || strings.ContainsAny(tag, "\n\r\x00\x1f") || seen[tag] {
			return status.Errorf(codes.InvalidArgument, "invalid or duplicate tag")
		}
		seen[tag] = true
	}
	return nil
}

const spaceTagSeparator = "\x1f"

func spaceTagKey(space, tag string) string {
	if space == "" {
		return tag
	}
	return space + spaceTagSeparator + tag
}

func tagBelongsToSpace(key, space string) bool {
	if space == "" {
		return !strings.Contains(key, spaceTagSeparator)
	}
	return strings.HasPrefix(key, space+spaceTagSeparator)
}

func scopeTagSetting(ctx context.Context, setting *v1pb.UserSetting) *v1pb.UserSetting {
	if setting == nil || setting.GetTagsSetting() == nil {
		return setting
	}
	space, _ := store.SpaceFromContext(ctx)
	tags := map[string]*v1pb.UserSetting_TagMetadata{}
	for key, value := range setting.GetTagsSetting().Tags {
		if tagBelongsToSpace(key, space) {
			if space != "" {
				key = strings.TrimPrefix(key, space+spaceTagSeparator)
			}
			tags[key] = value
		}
	}
	setting.GetTagsSetting().Tags = tags
	return setting
}
