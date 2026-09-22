package v1

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/usememos/memos/internal/memoexport"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

type archiveImportKey struct{}
type archiveImportJournalKey struct{}

type archiveImportJournal struct {
	memos       []*store.Memo
	attachments []*store.Attachment
}

func trackArchiveMemo(ctx context.Context, memo *store.Memo) {
	if journal, ok := ctx.Value(archiveImportJournalKey{}).(*archiveImportJournal); ok {
		journal.memos = append(journal.memos, memo)
	}
}

func isArchiveImport(ctx context.Context) bool {
	value, ok := ctx.Value(archiveImportKey{}).(bool)
	return ok && value
}

type archiveImportPlan struct {
	file          *memoexport.File
	spaces        map[string]string
	spaceIDs      map[string]string
	memoSpaces    map[string]string
	content       map[string]string
	skip          map[string]bool
	attachmentIDs map[string]string
}

// ImportMemoArchive preflights the complete archive before creating any records.
func (s *APIV1Service) ImportMemoArchive(ctx context.Context, request *v1pb.ImportMemoArchiveRequest) (*v1pb.ImportMemoArchiveResponse, error) {
	user, err := s.archiveUser(ctx)
	if err != nil {
		return nil, err
	}
	release, err := s.acquireArchive(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.WithValue(ctx, archiveImportKey{}, true), maxMemoArchiveDuration)
	defer cancel()
	ctx = withSuppressMentionNotifications(ctx)
	if request == nil || len(request.Content) == 0 || len(request.Content) > maxMemoArchiveBytes {
		return nil, status.Error(codes.InvalidArgument, "ZIP must be between 1 byte and 128 MiB")
	}
	response := &v1pb.ImportMemoArchiveResponse{}
	journal := &archiveImportJournal{}
	ctx = context.WithValue(ctx, archiveImportJournalKey{}, journal)
	completed := false
	defer func() {
		if completed {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		for _, attachment := range journal.attachments {
			if err := s.Store.DeleteAttachment(store.WithoutSpace(cleanup), &store.DeleteAttachment{ID: attachment.ID}); err != nil {
				response.Errors = append(response.Errors, attachment.UID+": attachment rollback failed; inspect before retry")
			}
		}
		for i := len(journal.memos) - 1; i >= 0; i-- {
			memo := journal.memos[i]
			if err := s.Store.DeleteMemo(store.WithSpace(cleanup, memo.Space), &store.DeleteMemo{ID: memo.ID}); err != nil {
				response.Errors = append(response.Errors, memo.UID+": memo rollback failed; inspect before retry")
			}
		}
		response.Imported = 0
		response.Attachments = 0
	}()
	plan, err := s.prepareArchiveImport(ctx, user, request.Content, response)
	if err != nil {
		return nil, err
	}
	// Settings are changed only after every content file and checksum is validated.
	if plan.spaces != nil {
		_, err = s.UpdateUserSetting(ctx, &v1pb.UpdateUserSettingRequest{Setting: &v1pb.UserSetting{Name: "users/" + user.Username + "/settings/GENERAL", Value: &v1pb.UserSetting_GeneralSetting_{GeneralSetting: &v1pb.UserSetting_GeneralSetting{Spaces: plan.spaces}}}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"spaces"}}})
		if err != nil {
			return nil, err
		}
	}
	imported := map[string]*v1pb.Memo{}
	for index, record := range plan.file.Memos {
		if plan.skip[record.UID] {
			response.Skipped++
			continue
		}
		if err := ctx.Err(); err != nil {
			response.Errors = append(response.Errors, fmt.Sprintf("%d remaining records were not processed: %s", len(plan.file.Memos)-index, err))
			return response, nil
		}
		itemCtx := store.WithSpace(ctx, plan.memoSpaces[record.UID])
		memo, attachmentCount, err := s.importArchiveMemo(itemCtx, user, plan, record, response)
		if err != nil {
			response.Errors = append(response.Errors, archiveItemError(record.UID, err))
			return response, nil
		}
		imported[record.UID] = memo
		response.Imported++
		response.Attachments += int32(attachmentCount)
	}
	// References are restored after all targets exist; skipped existing records are never updated.
	for _, record := range plan.file.Memos {
		memo := imported[record.UID]
		if memo == nil {
			continue
		}
		itemCtx := store.WithSpace(ctx, plan.memoSpaces[record.UID])
		var relations []*v1pb.MemoRelation
		for _, relation := range record.Relations {
			if _, ok := plan.memoSpaces[relation.Memo]; !ok || plan.memoSpaces[relation.Memo] != plan.memoSpaces[record.UID] {
				response.Warnings = append(response.Warnings, record.UID+": reference outside the imported personal space was omitted")
				continue
			}
			target, err := s.Store.GetMemo(itemCtx, &store.FindMemo{UID: &relation.Memo, CreatorID: &user.ID})
			if err != nil {
				response.Errors = append(response.Errors, archiveItemError(record.UID, err))
				return response, nil
			}
			if target == nil || target.IsTodo || memo.IsTodo {
				response.Warnings = append(response.Warnings, record.UID+": unavailable reference "+relation.Memo+" was omitted")
				continue
			}
			relations = append(relations, &v1pb.MemoRelation{Type: v1pb.MemoRelation_REFERENCE, RelatedMemo: &v1pb.MemoRelation_Memo{Name: "memos/" + relation.Memo}})
		}
		if len(relations) > 0 {
			if _, err := s.SetMemoRelations(itemCtx, &v1pb.SetMemoRelationsRequest{Name: memo.Name, Relations: relations}); err != nil {
				response.Errors = append(response.Errors, archiveItemError(record.UID, err))
				return response, nil
			}
		}
		updated, _ := memoexport.ParseTime(record.UpdateTime)
		memo.UpdateTime = timestamppb.New(time.Unix(updated, 0))
		memo.Pinned = record.Pinned
		memo.State = v1pb.State(v1pb.State_value[record.State])
		memo.Visibility = v1pb.Visibility(v1pb.Visibility_value[record.Visibility])
		if _, err := s.UpdateMemo(itemCtx, &v1pb.UpdateMemoRequest{Memo: memo, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"pinned", "state", "visibility", "update_time"}}}); err != nil {
			response.Errors = append(response.Errors, archiveItemError(record.UID, err))
			return response, nil
		}
	}
	completed = true
	for _, memo := range journal.memos {
		s.SSEHub.Broadcast(&SSEEvent{Type: SSEEventMemoCreated, Name: "memos/" + memo.UID, Visibility: store.Private, CreatorID: user.ID})
	}
	return response, nil
}

func (s *APIV1Service) prepareArchiveImport(ctx context.Context, user *store.User, data []byte, response *v1pb.ImportMemoArchiveResponse) (*archiveImportPlan, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid ZIP")
	}
	if len(reader.File) > maxMemoArchiveEntries {
		return nil, status.Error(codes.ResourceExhausted, "too many ZIP entries")
	}
	var expanded uint64
	for _, entry := range reader.File {
		if entry.UncompressedSize64 > maxMemoArchiveExpandedBytes-expanded {
			return nil, status.Error(codes.ResourceExhausted, "expanded ZIP exceeds 512 MiB")
		}
		expanded += entry.UncompressedSize64
	}
	archive, err := memoexport.Read(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid archive: %v", err)
	}
	if len(archive.Memos) > maxMemoArchiveMemos {
		return nil, status.Error(codes.ResourceExhausted, "archive exceeds 10000 memos")
	}
	if archive.Manifest.Scope.Kind != memoexport.ScopeKindUser {
		return nil, status.Error(codes.InvalidArgument, "only USER archives are supported")
	}
	for _, warning := range archive.Warnings {
		response.Warnings = append(response.Warnings, warning.String())
	}
	selected, err := s.validateSelectedSpace(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	setting, err := s.GetUserSetting(ctx, &v1pb.GetUserSettingRequest{Name: "users/" + user.Username + "/settings/GENERAL"})
	if err != nil {
		return nil, err
	}
	current := setting.GetGeneralSetting().GetSpaces()
	plan := &archiveImportPlan{file: archive, spaceIDs: map[string]string{"": ""}, memoSpaces: map[string]string{}, content: map[string]string{}, skip: map[string]bool{}, attachmentIDs: map[string]string{}}
	if extension := archive.Manifest.Castor; extension != nil {
		if extension.Version != 1 {
			return nil, status.Error(codes.InvalidArgument, "unsupported personal-space extension version")
		}
		if err := validateSpaces(extension.Spaces, nil); err != nil {
			return nil, err
		}
		plan.spaces = maps.Clone(current)
		if plan.spaces == nil {
			plan.spaces = map[string]string{}
		}
		for id, name := range extension.Spaces {
			target := id
			if existing, ok := current[id]; ok && existing != name {
				target, err = s.reusableArchiveSpace(ctx, user.ID, current, extension.Spaces, name)
				if err != nil {
					return nil, err
				}
				if target == "" {
					target, err = ValidateAndGenerateUID("")
					if err != nil {
						return nil, err
					}
				}
				response.Warnings = append(response.Warnings, id+": personal-space ID collision; new records use a separate space")
			}
			plan.spaceIDs[id] = target
			plan.spaces[target] = name
		}
	}
	storage, err := s.Store.GetInstanceStorageSetting(ctx)
	if err != nil {
		return nil, err
	}
	contentLimit, err := s.getContentLengthLimit(ctx)
	if err != nil {
		return nil, err
	}
	var logicalBytes int64
	hasNewMemo := false
	for _, record := range archive.Memos {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		space := selected
		if extension := record.Castor; extension != nil {
			if extension.Version != 1 || archive.Manifest.Castor == nil {
				return nil, status.Error(codes.InvalidArgument, "invalid personal memo extension")
			}
			var ok bool
			space, ok = plan.spaceIDs[extension.Space]
			if !ok {
				return nil, status.Errorf(codes.InvalidArgument, "memo %s references an unknown personal space", record.UID)
			}
		} else if record.Space != nil {
			response.Warnings = append(response.Warnings, record.UID+": upstream shared space mapped to the selected personal space")
		}
		plan.memoSpaces[record.UID] = space
		if record.Visibility == "SPACE" {
			record.Visibility = "PRIVATE"
			response.Warnings = append(response.Warnings, record.UID+": SPACE visibility restored as PRIVATE")
		}
		content, err := archive.Content(record)
		if err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "memo %s: %v", record.UID, err)
		}
		if !utf8.Valid(content) || len(content) > contentLimit {
			return nil, status.Errorf(codes.InvalidArgument, "memo %s content is invalid or exceeds the instance limit", record.UID)
		}
		if err := validateExplicitTags(record.Tags); err != nil {
			return nil, status.Errorf(codes.InvalidArgument, "memo %s: %v", record.UID, err)
		}
		plan.content[record.UID] = string(content)
		logicalBytes += int64(len(content))
		existing, err := s.Store.GetMemo(store.WithoutSpace(ctx), &store.FindMemo{UID: &record.UID})
		if err != nil {
			return nil, err
		}
		plan.skip[record.UID] = existing != nil
		hasNewMemo = hasNewMemo || existing == nil
		for _, attachment := range record.Attachments {
			if _, dup := plan.attachmentIDs[attachment.UID]; dup {
				return nil, status.Error(codes.InvalidArgument, "an attachment is assigned to multiple memos")
			}
			if !validateFilename(attachment.Filename) {
				return nil, status.Errorf(codes.InvalidArgument, "invalid attachment filename: %s", attachment.UID)
			}
			if attachment.Path != "" {
				if attachment.Size > maxMemoArchiveExpandedBytes-logicalBytes {
					return nil, status.Error(codes.ResourceExhausted, "restored data exceeds 512 MiB")
				}
				logicalBytes += attachment.Size
				if err := checkUploadSize(storage, attachment.Size); err != nil {
					return nil, status.Errorf(codes.InvalidArgument, "attachment %s exceeds the current upload limit", attachment.UID)
				}
				if _, err := archive.ReadAttachment(&attachment); err != nil {
					return nil, status.Errorf(codes.InvalidArgument, "attachment %s: %v", attachment.UID, err)
				}
			} else {
				link, err := url.Parse(attachment.ExternalLink)
				if err != nil || (link.Scheme != "https" && link.Scheme != "http") || link.Hostname() == "" || link.User != nil {
					return nil, status.Errorf(codes.InvalidArgument, "attachment %s has an invalid external URL", attachment.UID)
				}
			}
			uid := attachment.UID
			existing, err := s.Store.GetAttachment(store.WithoutSpace(ctx), &store.FindAttachment{UID: &uid})
			if err != nil {
				return nil, err
			}
			if existing != nil {
				uid, err = ValidateAndGenerateUID("")
				if err != nil {
					return nil, err
				}
			}
			plan.attachmentIDs[attachment.UID] = uid
			if len(attachment.MotionMedia) > 0 {
				var motion v1pb.MotionMedia
				if err := protojson.Unmarshal(attachment.MotionMedia, &motion); err != nil {
					return nil, status.Errorf(codes.InvalidArgument, "invalid motion metadata: %s", attachment.UID)
				}
				if motion.Family != v1pb.MotionMediaFamily_ANDROID_MOTION_PHOTO {
					if _, err := validateClientMotionMedia(&motion, uid); err != nil {
						return nil, err
					}
				}
			}
		}
		if len(record.Reactions) > 0 {
			response.Warnings = append(response.Warnings, record.UID+": reactions are not restored as other users")
		}
	}
	if logicalBytes > maxMemoArchiveExpandedBytes {
		return nil, status.Error(codes.ResourceExhausted, "restored data exceeds 512 MiB")
	}
	if !hasNewMemo {
		plan.spaces = nil
	} else if plan.spaces != nil {
		if err := validateSpaces(plan.spaces, current); err != nil {
			return nil, err
		}
	}
	return plan, nil
}

// Reuse an empty destination left by a rolled-back import without joining
// distinct source spaces or moving existing content.
func (s *APIV1Service) reusableArchiveSpace(ctx context.Context, userID int32, current, incoming map[string]string, name string) (string, error) {
	ids := slices.Sorted(maps.Keys(current))
	for _, id := range ids {
		if current[id] != name {
			continue
		}
		if _, sourceSpace := incoming[id]; sourceSpace {
			continue
		}
		spaceCtx := store.WithSpace(ctx, id)
		limit := 1
		memos, err := s.Store.ListMemos(spaceCtx, &store.FindMemo{CreatorID: &userID, Limit: &limit})
		if err != nil {
			return "", err
		}
		if len(memos) > 0 {
			continue
		}
		attachments, err := s.Store.ListAttachments(spaceCtx, &store.FindAttachment{CreatorID: &userID, Limit: &limit})
		if err != nil {
			return "", err
		}
		if len(attachments) == 0 {
			return id, nil
		}
	}
	return "", nil
}

func (s *APIV1Service) importArchiveMemo(ctx context.Context, user *store.User, plan *archiveImportPlan, record *memoexport.Memo, response *v1pb.ImportMemoArchiveResponse) (*v1pb.Memo, int, error) {
	var createdMemo *v1pb.Memo
	journal, ok := ctx.Value(archiveImportJournalKey{}).(*archiveImportJournal)
	if !ok || journal == nil {
		return nil, 0, status.Error(codes.Internal, "archive import journal is missing")
	}
	content := plan.content[record.UID]
	var attachments []*v1pb.Attachment
	for _, item := range record.Attachments {
		attachment, err := s.importArchiveAttachment(ctx, plan, &item)
		if err != nil {
			return nil, 0, err
		}
		journal.attachments = append(journal.attachments, attachment)
		attachments = append(attachments, convertAttachmentFromStore(attachment))
		if attachment.UID != item.UID {
			content = strings.ReplaceAll(content, "/file/attachments/"+item.UID+"/", "/file/attachments/"+attachment.UID+"/")
		}
	}
	created, _ := memoexport.ParseTime(record.CreateTime)
	updated, _ := memoexport.ParseTime(record.UpdateTime)
	// Keep every new record private until its archive state and visibility can be
	// restored in one update, including public records that were archived.
	memo := &v1pb.Memo{Content: content, Tags: record.Tags, ExplicitTags: true, Visibility: v1pb.Visibility_PRIVATE, CreateTime: timestamppb.New(time.Unix(created, 0)), UpdateTime: timestamppb.New(time.Unix(updated, 0)), Attachments: attachments}
	if record.Castor != nil {
		memo.IsTodo = record.Castor.IsTodo
		memo.ExplicitTags = record.Castor.ExplicitTags
	}
	if record.Location != nil {
		memo.Location = &v1pb.Location{Placeholder: record.Location.Placeholder, Latitude: record.Location.Latitude, Longitude: record.Location.Longitude}
	}
	var err error
	parentAvailable := false
	if record.Parent != "" {
		if _, included := plan.memoSpaces[record.Parent]; included && plan.memoSpaces[record.Parent] == plan.memoSpaces[record.UID] {
			parent, lookupErr := s.Store.GetMemo(ctx, &store.FindMemo{UID: &record.Parent, CreatorID: &user.ID})
			if lookupErr != nil {
				return nil, 0, lookupErr
			}
			parentAvailable = parent != nil && parent.ParentUID == nil && !parent.IsTodo && !memo.IsTodo
		}
		if !parentAvailable {
			memo.Visibility = v1pb.Visibility_PRIVATE
			record.Visibility = "PRIVATE"
			response.Warnings = append(response.Warnings, record.UID+": unavailable parent; imported as a private note")
		}
	}
	if parentAvailable {
		createdMemo, err = s.CreateMemoComment(ctx, &v1pb.CreateMemoCommentRequest{Name: "memos/" + record.Parent, Comment: memo, CommentId: record.UID})
	} else {
		createdMemo, err = s.CreateMemo(ctx, &v1pb.CreateMemoRequest{MemoId: record.UID, Memo: memo})
	}
	if err != nil {
		return nil, 0, err
	}
	return createdMemo, len(attachments), nil
}

func (s *APIV1Service) importArchiveAttachment(ctx context.Context, plan *archiveImportPlan, item *memoexport.Attachment) (*store.Attachment, error) {
	metadata := &v1pb.Attachment{Filename: item.Filename, Type: item.Type}
	var content []byte
	var err error
	if item.Path != "" {
		content, err = plan.file.ReadAttachment(item)
		if err != nil {
			return nil, err
		}
	}
	create, err := s.prepareAttachment(ctx, &v1pb.CreateAttachmentRequest{AttachmentId: plan.attachmentIDs[item.UID], Attachment: metadata})
	if err != nil {
		return nil, err
	}
	create.Size = item.Size
	create.CreatedTs, _ = memoexport.ParseTime(item.CreateTime)
	create.UpdatedTs = create.CreatedTs
	if len(item.MotionMedia) > 0 {
		var motion v1pb.MotionMedia
		if err := protojson.Unmarshal(item.MotionMedia, &motion); err != nil {
			return nil, err
		}
		if motion.Family == v1pb.MotionMediaFamily_ANDROID_MOTION_PHOTO {
			detected := detectAndroidMotionMedia(content, item.Type, create.UID)
			if detected == nil {
				return nil, status.Error(codes.InvalidArgument, "motion photo metadata does not match its bytes")
			}
			create.Payload = ensureAttachmentPayload(create.Payload)
			create.Payload.MotionMedia = detected
		} else {
			validated, err := validateClientMotionMedia(&motion, create.UID)
			if err != nil {
				return nil, err
			}
			create.Payload = ensureAttachmentPayload(create.Payload)
			create.Payload.MotionMedia = validated
		}
	}
	if item.ExternalLink != "" {
		create.StorageType = storepb.AttachmentStorageType_EXTERNAL
		create.Reference = item.ExternalLink
	} else {
		setting, err := s.Store.GetInstanceStorageSetting(ctx)
		if err != nil {
			return nil, err
		}
		if err := checkUploadSize(setting, int64(len(content))); err != nil {
			return nil, err
		}
		// Restoring verified archive bytes must not re-encode already stored JPEGs.
		if err := saveAttachmentContent(ctx, s.Profile, s.Store, create, bytes.NewReader(content)); err != nil {
			return nil, err
		}
	}
	persisted, err := s.Store.CreateAttachment(ctx, create)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		stored, lookupErr := s.Store.GetAttachment(store.WithoutSpace(cleanup), &store.FindAttachment{UID: &create.UID, GetBlob: true})
		if lookupErr != nil {
			return nil, status.Error(codes.Internal, "attachment outcome is unknown; inspect before retry")
		}
		if stored != nil && stored.CreatorID == create.CreatorID && stored.Space == create.Space && stored.Reference == create.Reference &&
			(create.Reference != "" || bytes.Equal(stored.Blob, create.Blob)) {
			return stored, nil
		}
		if cleanupErr := s.Store.DeleteAttachmentStorage(cleanup, create); cleanupErr != nil {
			return nil, status.Error(codes.Internal, "failed to save attachment and clean up its storage")
		}
		return nil, err
	}
	return persisted, nil
}
