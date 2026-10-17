import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoService } from "@/components/MemoEditor/services/memoService";
import { createInitialState } from "@/components/MemoEditor/state";
import { MemoSchema, Visibility } from "@/types/proto/api/v1/memo_service_pb";

const clients = vi.hoisted(() => ({ getMemo: vi.fn(), updateMemo: vi.fn(), createMemo: vi.fn() }));
vi.mock("@/connect", () => ({ memoServiceClient: clients }));

describe("memo MCP privacy", () => {
  beforeEach(() => {
    clients.updateMemo.mockImplementation(async ({ memo }) => memo);
    clients.createMemo.mockImplementation(async ({ memo }) => ({ ...memo, name: "memos/new" }));
  });

  it.each([false, true])("creates private memos and todos without changing public visibility (todo=%s)", async (isTodo) => {
    const state = createInitialState();
    state.content = "Content";
    state.metadata = { ...state.metadata, visibility: Visibility.PUBLIC, isTodo, mcpHidden: true };
    await memoService.save(state, {});
    expect(clients.createMemo.mock.calls[0][0].memo).toMatchObject({ mcpHidden: true, isTodo, visibility: Visibility.PUBLIC });
  });

  it.each([false, true])("updates only MCP privacy when toggled from %s", async (mcpHidden) => {
    const memo = create(MemoSchema, { name: "memos/private", content: "Content", explicitTags: true, visibility: Visibility.PUBLIC, mcpHidden });
    clients.getMemo.mockResolvedValue(memo);
    const state = { ...createInitialState(), ...memoService.fromMemo(memo) };
    expect(state.metadata.mcpHidden).toBe(mcpHidden);
    state.metadata.mcpHidden = !mcpHidden;
    await memoService.save(state, { memoName: memo.name });
    expect(clients.updateMemo.mock.calls[0][0].updateMask.paths).toEqual(["mcp_hidden"]);
    expect(clients.updateMemo.mock.calls[0][0].memo.mcpHidden).toBe(!mcpHidden);
  });
});
