import { memoServiceClient } from "@/connect";
import { State } from "@/types/proto/api/v1/common_pb";

export const renamedTag = (value: string, from: string, to: string) =>
  value === from || value.startsWith(`${from}/`) ? to + value.slice(from.length) : value;

// Collect every page before writing: renaming changes which records match and their update order.
export async function renameTagInMemos(user: string, from: string, to: string) {
  const names = new Set<string>();
  for (const isTodo of [false, true]) {
    for (const state of [State.NORMAL, State.ARCHIVED]) {
      let pageToken = "";
      do {
        const page = await memoServiceClient.listMemos({
          filter: `creator == ${JSON.stringify(user)}`,
          state,
          isTodo,
          pageSize: 1000,
          pageToken,
        });
        for (const memo of page.memos) {
          if (memo.creator === user && memo.tags.some((tag) => renamedTag(tag, from, to) !== tag)) {
            if (memo.tags.some((tag) => new TextEncoder().encode(renamedTag(tag, from, to)).length > 256)) {
              throw new Error("重命名后的子标签超过 256 字节，请缩短名称");
            }
            names.add(memo.name);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
  }
  for (const name of names) {
    const memo = await memoServiceClient.getMemo({ name });
    if (memo.creator !== user) continue;
    const tags = [...new Set(memo.tags.map((tag) => renamedTag(tag, from, to)))];
    if (tags.length === memo.tags.length && tags.every((tag, index) => tag === memo.tags[index])) continue;
    await memoServiceClient.updateMemo({ memo: { name, tags }, updateMask: { paths: ["tags"] } });
  }
}
