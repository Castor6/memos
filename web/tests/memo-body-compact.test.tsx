vi.mock("@/components/MemoContent/Tag", () => ({ Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ userGeneralSetting: {} }) }));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAMP_PREVIEW_HEIGHT_PX, CLAMP_TRIGGER_HEIGHT_PX } from "@/components/ClampedSection";
import MemoBody from "@/components/MemoView/components/MemoBody";
import { PrivateMemoVisibilityProvider, usePrivateMemoVisibility } from "@/contexts/PrivateMemoVisibilityContext";

const mockState = vi.hoisted(() => ({
  blurred: false,
  toggleBlurVisibility: vi.fn(),
  memo: {
    name: "memos/1",
    mcpHidden: false,
    content: "",
    relations: [],
    attachments: [],
    reactions: [],
    tags: [],
  },
}));

vi.mock("@/utils/i18n", () => ({
  useTranslate: () => (key: string) => key,
}));

vi.mock("@/components/MemoContent/MentionResolutionContext", () => ({
  useResolvedMentionUsernames: () => new Set<string>(),
}));

vi.mock("@/components/MemoContent/MemoMarkdownRenderer", () => ({
  MemoMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock("@/components/MemoMetadata", () => ({
  AttachmentListView: () => null,
  LocationDisplayView: () => null,
  RelationListView: () => null,
}));

vi.mock("@/components/MemoReactionListView", () => ({
  MemoReactionListView: () => null,
}));

vi.mock("@/components/MemoView/hooks", () => ({
  useMemoHandlers: () => ({
    handleMemoContentClick: vi.fn(),
    handleMemoContentDoubleClick: vi.fn(),
  }),
}));

vi.mock("@/components/MemoView/MemoViewContext", () => ({
  useMemoViewContext: () => ({
    memo: mockState.memo,
    parentPage: "",
    showBlurredContent: false,
    blurred: mockState.blurred,
    readonly: false,
    openEditor: vi.fn(),
    openPreview: vi.fn(),
    toggleBlurVisibility: mockState.toggleBlurVisibility,
  }),
}));

const createMemo = (content: string) => ({
  name: "memos/1",
  mcpHidden: false,
  content,
  tags: [],
  relations: [],
  attachments: [],
  reactions: [],
});

afterEach(() => {
  mockState.blurred = false;
  mockState.toggleBlurVisibility.mockClear();
  vi.restoreAllMocks();
});

describe("<MemoBody /> compact body clamp", () => {
  it("keeps a buffer between the preview height and the fold trigger", () => {
    expect(CLAMP_TRIGGER_HEIGHT_PX).toBeGreaterThan(CLAMP_PREVIEW_HEIGHT_PX);
  });

  it("folds tall compact bodies and keeps them expanded across content changes", async () => {
    // jsdom has no layout; report every element as taller than the fold trigger.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(CLAMP_TRIGGER_HEIGHT_PX + 100);

    mockState.memo = createMemo("line 1\nline 2");
    const { rerender } = render(<MemoBody compact={true} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /memo\.show-more/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /memo\.show-more/ }));
    expect(screen.getByRole("button", { name: /memo\.show-less/ })).toBeInTheDocument();

    mockState.memo = createMemo("line 1\nline 2 updated");
    rerender(<MemoBody compact={true} />);

    expect(screen.getByRole("button", { name: /memo\.show-less/ })).toBeInTheDocument();
  });

  it("renders no clamp when compact is off", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(CLAMP_TRIGGER_HEIGHT_PX + 100);

    mockState.memo = createMemo("tall content");
    render(<MemoBody compact={false} />);

    expect(screen.queryByRole("button", { name: /memo\.show-more/ })).toBeNull();
  });
});

const GlobalPrivacyToggle = () => {
  const { toggleAll } = usePrivateMemoVisibility();
  return <button onClick={toggleAll}>Toggle all</button>;
};

describe("<MemoBody /> private and sensitive content", () => {
  it("gives private masking priority and reveals dual-marked content without a central label", () => {
    mockState.memo = { ...createMemo("private sensitive content"), mcpHidden: true };
    mockState.blurred = true;
    const { container } = render(
      <PrivateMemoVisibilityProvider>
        <MemoBody />
      </PrivateMemoVisibilityProvider>,
    );

    const reveal = screen.getByRole("button", { name: "memo.mcp-privacy.show-content" });
    expect(reveal).toBeEmptyDOMElement();
    expect(screen.queryByText("memo.click-to-show-sensitive-content")).not.toBeInTheDocument();
    expect(screen.getByText("private sensitive content").closest("[inert]")).not.toBeNull();

    fireEvent.click(reveal);
    expect(container.querySelector('[data-content-hidden="true"]')).toBeNull();
    expect(mockState.toggleBlurVisibility).not.toHaveBeenCalled();
  });

  it("reveals dual-marked content through the global control and masks it again when closed", () => {
    mockState.memo = { ...createMemo("globally controlled content"), mcpHidden: true };
    mockState.blurred = true;
    const { container } = render(
      <PrivateMemoVisibilityProvider>
        <GlobalPrivacyToggle />
        <MemoBody />
      </PrivateMemoVisibilityProvider>,
    );

    expect(container.querySelector('[data-content-hidden="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle all" }));
    expect(container.querySelector('[data-content-hidden="true"]')).toBeNull();
    expect(screen.getByText("globally controlled content").closest("[inert]")).toBeNull();
    expect(screen.queryByText("memo.click-to-show-sensitive-content")).not.toBeInTheDocument();
    expect(mockState.toggleBlurVisibility).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Toggle all" }));
    expect(screen.getByRole("button", { name: "memo.mcp-privacy.show-content" })).toBeEmptyDOMElement();
    expect(container.querySelector('[data-content-hidden="true"]')).not.toBeNull();
  });

  it("keeps the existing text mask and reveal handler for sensitive content without the private flag", () => {
    mockState.memo = createMemo("ordinary sensitive content");
    mockState.blurred = true;
    render(
      <PrivateMemoVisibilityProvider>
        <GlobalPrivacyToggle />
        <MemoBody />
      </PrivateMemoVisibilityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle all" }));
    const reveal = screen.getByRole("button", { name: "memo.click-to-show-sensitive-content" });
    expect(reveal).toHaveTextContent("memo.click-to-show-sensitive-content");
    expect(screen.getByText("ordinary sensitive content").closest("[inert]")).not.toBeNull();
    fireEvent.click(reveal);
    expect(mockState.toggleBlurVisibility).toHaveBeenCalledOnce();
  });
});
