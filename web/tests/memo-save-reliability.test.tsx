import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemoSave } from "@/components/MemoEditor/hooks/useMemoSave";
import { EditorProvider, useEditorContext } from "@/components/MemoEditor/state";
import { createInitialState } from "@/components/MemoEditor/state/types";

const saveMemo = vi.hoisted(() => vi.fn());
vi.mock("@/components/MemoEditor/services", async (original) => ({
  ...(await original<typeof import("@/components/MemoEditor/services")>()),
  memoService: { save: saveMemo },
}));
vi.mock("@/contexts/MemoFilterContext", () => ({ useMemoFilterContext: () => ({ filters: [] }) }));
vi.mock("@/contexts/NewMemoContext", () => ({ useNewMemo: () => ({ markNewMemo: vi.fn() }) }));
vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));

afterEach(() => vi.useRealTimers());

describe("memo save transaction", () => {
  it("freezes the saved snapshot and finishes before background refresh completes", async () => {
    vi.useFakeTimers();
    let finishSave!: (value: { memoName: string; hasChanges: boolean }) => void;
    saveMemo.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(new Promise(() => {}));
    const discardDraft = vi.fn();
    const onConfirm = vi.fn();
    const initial = { ...createInitialState(), content: "saved content" };
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>
        <EditorProvider initialEditorState={initial}>{children}</EditorProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        save: useMemoSave({ discardDraft, onConfirm }),
        store: useEditorContext(),
      }),
      { wrapper },
    );

    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
    });
    expect(result.current.store.getState().ui.isLoading.saving).toBe(true);
    act(() => {
      result.current.store.dispatch(result.current.store.actions.updateContent("late input"));
      result.current.store.dispatch(result.current.store.actions.setMetadata({ tags: ["late-tag"] }));
    });
    expect(result.current.store.getState().content).toBe("saved content");
    expect(result.current.store.getState().metadata.tags).toBeUndefined();
    await act(async () => {
      finishSave({ memoName: "memos/saved", hasChanges: true });
      await saving;
    });
    expect(onConfirm).toHaveBeenCalledWith("memos/saved");
    expect(discardDraft).toHaveBeenCalledOnce();
    expect(result.current.store.getState().ui.isLoading.saving).toBe(false);
    expect(result.current.store.getState().content).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(invalidate).toHaveBeenCalled();
    act(() => {
      result.current.store.dispatch(result.current.store.actions.updateContent("next memo"));
    });
    expect(result.current.store.getState().content).toBe("next memo");
    client.clear();
  });

  it("keeps the draft and releases the editor when saving fails", async () => {
    saveMemo.mockRejectedValue(new Error("offline"));
    const discardDraft = vi.fn();
    const client = new QueryClient();
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>
        <EditorProvider initialEditorState={{ ...createInitialState(), content: "draft" }}>{children}</EditorProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => ({ save: useMemoSave({ discardDraft }), store: useEditorContext() }), { wrapper });
    await act(async () => {
      await result.current.save();
    });
    expect(discardDraft).not.toHaveBeenCalled();
    expect(result.current.store.getState().content).toBe("draft");
    expect(result.current.store.getState().ui.isLoading.saving).toBe(false);
    client.clear();
  });
});
