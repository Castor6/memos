import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { isEqual } from "lodash-es";
import { memoServiceClient } from "@/connect";
import { FILE_TITLE, fileMarkdown, REFERENCE_TITLE } from "@/lib/inline-media";
import { getActiveSpace } from "@/lib/personal-space";
import type { Attachment } from "@/types/proto/api/v1/attachment_service_pb";
import { AttachmentSchema } from "@/types/proto/api/v1/attachment_service_pb";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { MemoRelation_Type, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";
import { getAttachmentUrl } from "@/utils/attachment";
import type { EditorState } from "../state";

/**
 * Converts attachments to reference format for API requests.
 * The backend only needs the attachment name to link it to a memo.
 */
function toAttachmentReferences(attachments: Attachment[]): Attachment[] {
  return attachments.map((a) => create(AttachmentSchema, { name: a.name }));
}

function buildUpdateMask(
  prevMemo: Memo,
  state: EditorState,
  allAttachments: typeof state.metadata.attachments,
): { mask: Set<string>; patch: Partial<Memo> } {
  const mask = new Set<string>();
  const patch: Partial<Memo> = {
    name: prevMemo.name,
    content: state.content,
  };

  if (!isEqual(state.content, prevMemo.content)) {
    mask.add("content");
    patch.content = state.content;
  }
  if (!isEqual(state.metadata.tags ?? [], prevMemo.tags) || !prevMemo.explicitTags) {
    mask.add("tags");
    patch.tags = state.metadata.tags ?? [];
  }
  if (!isEqual(state.metadata.visibility, prevMemo.visibility)) {
    mask.add("visibility");
    patch.visibility = state.metadata.visibility;
  }
  if (!isEqual(allAttachments, prevMemo.attachments)) {
    mask.add("attachments");
    patch.attachments = toAttachmentReferences(allAttachments);
  }
  if (!isEqual(state.metadata.relations, prevMemo.relations)) {
    mask.add("relations");
    patch.relations = state.metadata.relations;
  }
  if (!isEqual(state.metadata.location, prevMemo.location)) {
    mask.add("location");
    patch.location = state.metadata.location;
  }

  // Auto-update timestamp if content changed
  if (["content", "attachments", "relations", "location", "tags"].some((key) => mask.has(key))) {
    mask.add("update_time");
  }

  // Handle custom timestamps
  if (state.timestamps.createTime) {
    const prevCreateTime = prevMemo.createTime ? timestampDate(prevMemo.createTime) : undefined;
    if (!isEqual(state.timestamps.createTime, prevCreateTime)) {
      mask.add("create_time");
      patch.createTime = timestampFromDate(state.timestamps.createTime);
    }
  }
  if (state.timestamps.updateTime) {
    const prevUpdateTime = prevMemo.updateTime ? timestampDate(prevMemo.updateTime) : undefined;
    if (!isEqual(state.timestamps.updateTime, prevUpdateTime)) {
      mask.add("update_time");
      patch.updateTime = timestampFromDate(state.timestamps.updateTime);
    }
  }

  return { mask, patch };
}

export const memoService = {
  async save(
    state: EditorState,
    options: {
      memoName?: string;
      parentMemoName?: string;
    },
  ): Promise<{ memoName: string; hasChanges: boolean }> {
    // Uploads are completed in place by EditorContent before saving.
    if (state.localFiles.length) throw new Error("请等待文件上传完成");
    const allAttachments = state.metadata.attachments.filter(
      (attachment) =>
        state.content.includes(attachment.name) ||
        state.content.includes(getAttachmentUrl(attachment)) ||
        state.content.includes(encodeURI(getAttachmentUrl(attachment))),
    );
    state = {
      ...state,
      metadata: {
        ...state.metadata,
        relations: state.metadata.relations.filter(
          (relation) => relation.type !== MemoRelation_Type.REFERENCE || state.content.includes(`/${relation.relatedMemo?.name}`),
        ),
      },
    };

    // 2. Update existing memo
    if (options.memoName) {
      const prevMemo = await memoServiceClient.getMemo({ name: options.memoName });
      const { mask, patch } = buildUpdateMask(prevMemo, state, allAttachments);

      if (mask.size === 0) {
        return { memoName: prevMemo.name, hasChanges: false };
      }

      const memo = await memoServiceClient.updateMemo({
        memo: create(MemoSchema, patch as Record<string, unknown>),
        updateMask: create(FieldMaskSchema, { paths: Array.from(mask) }),
      });
      return { memoName: memo.name, hasChanges: true };
    }

    // 3. Create new memo or comment
    const memoData = create(MemoSchema, {
      content: state.content,
      tags: state.metadata.tags ?? [],
      explicitTags: true,
      space: getActiveSpace(),
      isTodo: state.metadata.isTodo ?? false,
      visibility: state.metadata.visibility,
      attachments: toAttachmentReferences(allAttachments),
      relations: state.metadata.relations,
      location: state.metadata.location,
      createTime: state.timestamps.createTime ? timestampFromDate(state.timestamps.createTime) : undefined,
      updateTime: state.timestamps.updateTime ? timestampFromDate(state.timestamps.updateTime) : undefined,
    });

    const memo = options.parentMemoName
      ? await memoServiceClient.createMemoComment({
          name: options.parentMemoName,
          comment: memoData,
        })
      : await memoServiceClient.createMemo({ memo: memoData });

    return { memoName: memo.name, hasChanges: true };
  },

  /**
   * Build the INIT_MEMO payload from an already-loaded Memo entity (no network
   * request). Returns only the fields the reducer's INIT_MEMO case consumes —
   * UI state (mode, loading flags, …) is owned by the reducer, not by memos.
   */
  fromMemo(memo: Memo): Pick<EditorState, "content" | "metadata" | "timestamps"> {
    return {
      content:
        memo.content +
        memo.attachments
          .filter((attachment) => !memo.content.includes(attachment.name) && !memo.content.includes(getAttachmentUrl(attachment)))
          .map(
            (attachment) => `

${fileMarkdown(getAttachmentUrl(attachment), FILE_TITLE + attachment.type, attachment.filename)}`,
          )
          .join("") +
        memo.relations
          .filter(
            (relation) =>
              relation.type === MemoRelation_Type.REFERENCE &&
              relation.memo?.name === memo.name &&
              relation.relatedMemo &&
              !memo.content.includes(`/${relation.relatedMemo.name}`),
          )
          .map(
            (relation) =>
              `\n\n${fileMarkdown(`/${relation.relatedMemo!.name}`, REFERENCE_TITLE, relation.relatedMemo!.snippet || "笔记引用")}`,
          )
          .join(""),
      metadata: {
        tags: memo.tags,
        isTodo: memo.isTodo,
        visibility: memo.visibility,
        attachments: memo.attachments,
        relations: memo.relations,
        location: memo.location,
      },
      timestamps: {
        createTime: memo.createTime ? timestampDate(memo.createTime) : undefined,
        updateTime: memo.updateTime ? timestampDate(memo.updateTime) : undefined,
      },
    };
  },
};
