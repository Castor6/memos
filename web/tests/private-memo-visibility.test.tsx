import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import MemoContentMask from "@/components/MemoContentMask";
import PropertyFilters from "@/components/MemoExplorer/PropertyFilters";
import MemoPrivacyGuard from "@/components/MemoPrivacyGuard";
import { MemoFilterProvider, useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { PrivateMemoVisibilityProvider, usePrivateMemoVisibility } from "@/contexts/PrivateMemoVisibilityContext";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ shortcuts: [] }) }));

const privateMemo = create(MemoSchema, { name: "memos/private", mcpHidden: true });
const secondMemo = create(MemoSchema, { name: "memos/second", mcpHidden: true });
const normalMemo = create(MemoSchema, { name: "memos/normal" });

function Controls() {
  const { showAll, toggleAll } = usePrivateMemoVisibility();
  return <button onClick={toggleAll}>{showAll ? "Hide all" : "Show all"}</button>;
}

function Memos({ memo = privateMemo }: { memo?: typeof privateMemo }) {
  return <>
    <MemoPrivacyGuard memo={memo}><p>private text</p><a href="#file">attachment</a></MemoPrivacyGuard>
    <MemoPrivacyGuard memo={secondMemo}><p>second text</p></MemoPrivacyGuard>
    <MemoPrivacyGuard memo={normalMemo}><p>normal text</p></MemoPrivacyGuard>
  </>;
}

function hidden(text: string) {
  return screen.getByText(text).closest("[data-content-hidden=true]") !== null;
}

describe("private memo disclosure", () => {
  it("starts hidden without a visible label, reveals one memo and clears single reveals when hiding all", () => {
    render(<PrivateMemoVisibilityProvider><Controls /><Memos /></PrivateMemoVisibilityProvider>);
    expect(hidden("private text")).toBe(true);
    expect(hidden("second text")).toBe(true);
    expect(hidden("normal text")).toBe(false);
    expect(screen.queryByRole("link", { name: "attachment" })).toBeNull();
    const reveal = screen.getAllByRole("button", { name: "memo.mcp-privacy.show-content" })[0];
    expect(reveal.textContent).toBe("");
    expect(screen.getByText("private text").parentElement).toHaveAttribute("inert");
    fireEvent.click(reveal);
    expect(hidden("private text")).toBe(false);
    expect(hidden("second text")).toBe(true);
    fireEvent.click(screen.getByText("Show all"));
    expect(hidden("second text")).toBe(false);
    fireEvent.click(screen.getByText("Hide all"));
    expect(hidden("private text")).toBe(true);
    expect(hidden("second text")).toBe(true);
  });

  it("shares a reveal across surfaces, but hides a changed revision and a fresh session", () => {
    const view = render(<PrivateMemoVisibilityProvider><Controls /><Memos /></PrivateMemoVisibilityProvider>);
    fireEvent.click(screen.getAllByRole("button", { name: "memo.mcp-privacy.show-content" })[0]);
    view.rerender(<PrivateMemoVisibilityProvider><Controls /><Memos /><MemoPrivacyGuard memo={privateMemo}>same memo sidebar</MemoPrivacyGuard></PrivateMemoVisibilityProvider>);
    expect(hidden("same memo sidebar")).toBe(false);
    view.rerender(<PrivateMemoVisibilityProvider><Controls /><Memos memo={{ ...privateMemo, updateTime: timestampFromDate(new Date("2026-10-25")) }} /></PrivateMemoVisibilityProvider>);
    expect(hidden("private text")).toBe(true);
    fireEvent.click(screen.getByText("Show all"));
    view.unmount();
    render(<PrivateMemoVisibilityProvider><Controls /><Memos /></PrivateMemoVisibilityProvider>);
    expect(hidden("private text")).toBe(true);
    expect(screen.getByText("Show all")).toBeInTheDocument();
  });

  it("forgets disclosure when a memo becomes non-private, even without a timestamp change", () => {
    const view = render(<PrivateMemoVisibilityProvider><Memos /></PrivateMemoVisibilityProvider>);
    fireEvent.click(screen.getAllByRole("button", { name: "memo.mcp-privacy.show-content" })[0]);
    view.rerender(<PrivateMemoVisibilityProvider><Memos memo={{ ...privateMemo, mcpHidden: false }} /></PrivateMemoVisibilityProvider>);
    view.rerender(<PrivateMemoVisibilityProvider><Memos /></PrivateMemoVisibilityProvider>);
    expect(hidden("private text")).toBe(true);
  });

  it("does not activate a surrounding selection action when revealing", () => {
    const choose = vi.fn();
    render(<div onClick={choose}><MemoPrivacyGuard memo={privateMemo}>preview text</MemoPrivacyGuard></div>);
    fireEvent.click(screen.getByRole("button", { name: "memo.mcp-privacy.show-content" }));
    expect(choose).not.toHaveBeenCalled();
    expect(hidden("preview text")).toBe(false);
  });

  it("retains the existing optional sensitive-tag label", () => {
    render(<MemoContentMask hidden onReveal={() => {}} label="Sensitive tag" showLabel>body</MemoContentMask>);
    expect(screen.getByRole("button", { name: "Sensitive tag" })).toHaveTextContent("Sensitive tag");
  });
});

function FilterProbe() {
  const { filters } = useMemoFilterContext();
  return <output data-testid="filters">{JSON.stringify(filters)}</output>;
}

describe("private filter and visibility segmented control", () => {
  it("keeps filtering and disclosure independent and always uses the standard unslashed eye", () => {
    render(<MemoryRouter><PrivateMemoVisibilityProvider><MemoFilterProvider><PropertyFilters /><FilterProbe /><Memos /></MemoFilterProvider></PrivateMemoVisibilityProvider></MemoryRouter>);
    const filter = screen.getByRole("button", { name: "memo.mcp-privacy.label" });
    const show = screen.getByRole("button", { name: "memo.mcp-privacy.show-all" });
    expect(show.querySelector("svg.lucide-eye")).not.toBeNull();
    expect(show.querySelector("svg.lucide-eye-off")).toBeNull();
    fireEvent.click(show);
    expect(filter).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("filters")).toHaveTextContent("[]");
    expect(hidden("private text")).toBe(false);
    fireEvent.click(filter);
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("filters")).toHaveTextContent("mcpHidden");
    expect(hidden("private text")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "memo.mcp-privacy.hide-all" }));
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(hidden("private text")).toBe(true);
  });
});
