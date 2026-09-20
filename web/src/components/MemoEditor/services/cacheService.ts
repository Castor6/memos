import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { getActiveSpace } from "@/lib/personal-space";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";
import type { EditorState } from "../state";
export const CACHE_DEBOUNCE_DELAY = 500;

const pendingSaves = new Map<string, number>();
const STRUCTURED_CACHE_ENTRY_KIND = "memos.editor-cache";
const STRUCTURED_CACHE_ENTRY_VERSION = 1;

function deserializeContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; version?: unknown; content?: unknown };
    if (
      parsed.kind === STRUCTURED_CACHE_ENTRY_KIND &&
      parsed.version === STRUCTURED_CACHE_ENTRY_VERSION &&
      typeof parsed.content === "string"
    ) {
      return parsed.content;
    }
  } catch {
    // Drafts have historically been stored as raw markdown strings.
  }

  return raw;
}

function writeEntry(key: string, content: string, metadata?: EditorState["metadata"]): void {
  if (content.trim()) {
    localStorage.setItem(
      key,
      metadata
        ? JSON.stringify({
            kind: STRUCTURED_CACHE_ENTRY_KIND,
            version: STRUCTURED_CACHE_ENTRY_VERSION,
            content,
            memo: toJsonString(
              MemoSchema,
              create(MemoSchema, {
                tags: metadata.tags,
                attachments: metadata.attachments,
                relations: metadata.relations,
                isTodo: metadata.isTodo,
              }),
            ),
          })
        : content,
    );
  } else {
    localStorage.removeItem(key);
  }
}

export const cacheService = {
  key: (username: string, cacheKey?: string): string => {
    return `${username}-${cacheKey || ""}${getActiveSpace() ? `-space-${getActiveSpace()}` : ""}`;
  },

  save: (key: string, content: string, metadata?: EditorState["metadata"]) => {
    const pendingSave = pendingSaves.get(key);
    if (pendingSave) {
      window.clearTimeout(pendingSave);
    }

    const timeoutId = window.setTimeout(() => {
      pendingSaves.delete(key);

      writeEntry(key, content, metadata);
    }, CACHE_DEBOUNCE_DELAY);

    pendingSaves.set(key, timeoutId);
  },

  saveNow: (key: string, content: string, metadata?: EditorState["metadata"]) => {
    const pendingSave = pendingSaves.get(key);
    if (pendingSave) {
      window.clearTimeout(pendingSave);
      pendingSaves.delete(key);
    }

    writeEntry(key, content, metadata);
  },

  load(key: string): string {
    const raw = localStorage.getItem(key);
    return raw ? deserializeContent(raw) : "";
  },

  loadMetadata(key: string): Partial<EditorState["metadata"]> | undefined {
    try {
      const entry = JSON.parse(localStorage.getItem(key) || "null");
      if (entry?.kind !== STRUCTURED_CACHE_ENTRY_KIND || typeof entry.memo !== "string") return;
      const memo = fromJsonString(MemoSchema, entry.memo);
      return { tags: memo.tags, attachments: memo.attachments, relations: memo.relations };
    } catch {
      return;
    }
  },

  clear(key: string): void {
    const pendingSave = pendingSaves.get(key);
    if (pendingSave) {
      window.clearTimeout(pendingSave);
      pendingSaves.delete(key);
    }

    localStorage.removeItem(key);
  },

  clearAll(): void {
    for (const timeoutId of pendingSaves.values()) {
      window.clearTimeout(timeoutId);
    }
    pendingSaves.clear();
  },
};
