import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorProvider, useEditorContext } from "@/components/MemoEditor/state";
import { EditorWordCount } from "@/components/MemoEditor/Toolbar/EditorWordCount";

describe("editor word count", () => {
  it("updates with typing and resets without re-rendering the surrounding toolbar", () => {
    let store!: ReturnType<typeof useEditorContext>;
    let toolbarRenders = 0;
    const Toolbar = () => {
      toolbarRenders++;
      store = useEditorContext();
      return <EditorWordCount />;
    };
    render(<EditorProvider><Toolbar /></EditorProvider>);
    expect(screen.getByText("0 words")).toBeInTheDocument();
    const initialRenders = toolbarRenders;
    act(() => store.dispatch(store.actions.updateContent("你好 world 123")));
    expect(screen.getByText("4 words")).toBeInTheDocument();
    act(() => store.dispatch(store.actions.reset()));
    expect(screen.getByText("0 words")).toBeInTheDocument();
    expect(toolbarRenders).toBe(initialRenders);
  });
});
