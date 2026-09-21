import { createContext, useContext, useMemo } from "react";
import type { LinkMetadata } from "@/types/proto/api/v1/memo_service_pb";

interface MarkdownRenderContextValue {
  blockDepth: number;
  linkMetadata?: LinkMetadata[];
}

export const rootMarkdownRenderContext: MarkdownRenderContextValue = {
  blockDepth: 0,
};

export const MarkdownRenderContext = createContext<MarkdownRenderContextValue>(rootMarkdownRenderContext);

export const useMarkdownRenderContext = () => {
  return useContext(MarkdownRenderContext);
};

export const NestedMarkdownRenderContext = ({ children }: { children: React.ReactNode }) => {
  const { blockDepth, linkMetadata } = useMarkdownRenderContext();
  const value = useMemo<MarkdownRenderContextValue>(() => ({ blockDepth: blockDepth + 1, linkMetadata }), [blockDepth, linkMetadata]);

  return <MarkdownRenderContext.Provider value={value}>{children}</MarkdownRenderContext.Provider>;
};
