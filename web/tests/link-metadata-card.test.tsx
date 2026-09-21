import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LinkMetadataCard from "@/components/MemoContent/LinkMetadataCard";
import { MarkdownRenderContext } from "@/components/MemoContent/MarkdownRenderContext";
import { LinkMetadataSchema } from "@/types/proto/api/v1/memo_service_pb";

const query = vi.hoisted(() => ({
  isSuccess: true,
  data: { url: "https://example.com/article", title: "Article title", description: "Description", image: "" },
}));

vi.mock("@/hooks/useMemoQueries", () => ({ useLinkMetadata: () => query }));

const renderCard = () => render(<LinkMetadataCard url={query.data.url} fallback={<a href={query.data.url}>{query.data.url}</a>} />);

beforeEach(() => {
  query.isSuccess = true;
  query.data = { url: "https://example.com/article", title: "Article title", description: "Description", image: "" };
});

describe("link metadata card fallback", () => {
  it.each(["", " \n "])("keeps the original link when title is %j, even with a description and image", (title) => {
    query.data.title = title;
    query.data.image = "https://example.com/cover.jpg";
    renderCard();
    expect(screen.getByRole("link", { name: query.data.url })).toBeInTheDocument();
    expect(screen.queryByText("Description")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps the original link when fetching fails", () => {
    query.isSuccess = false;
    renderCard();
    expect(screen.getByRole("link", { name: query.data.url })).toBeInTheDocument();
    expect(screen.queryByText("Article title")).not.toBeInTheDocument();
  });

  it("renders a title without requiring a description or image", () => {
    query.data.description = "";
    renderCard();
    expect(screen.getByText("Article title")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", query.data.url);
  });
});

it("renders the persisted title immediately without waiting for the metadata query", () => {
  query.isSuccess = false;
  render(
    <MarkdownRenderContext.Provider
      value={{
        blockDepth: 0,
        linkMetadata: [create(LinkMetadataSchema, { url: query.data.url, title: "历史标题", description: "历史摘要" })],
      }}
    >
      <LinkMetadataCard url={query.data.url} fallback={<a href={query.data.url}>{query.data.url}</a>} />
    </MarkdownRenderContext.Provider>,
  );
  expect(screen.getByText("历史标题")).toBeInTheDocument();
  expect(screen.getByText("历史摘要")).toBeInTheDocument();
  expect(screen.queryByText(query.data.url)).not.toBeInTheDocument();
});
