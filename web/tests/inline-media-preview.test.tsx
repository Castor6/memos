import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { remarkHighlight } from "@/utils/remark-plugins/remark-highlight";
import { remarkPreview, visibleCharacterCount } from "@/utils/remark-plugins/remark-preview";
import { fileMarkdown } from "@/lib/inline-media";

describe("inline media and previews", () => {
  it("quotes spaces and filenames without creating Markdown nodes", () => {
    const markdown = fileMarkdown('/file/hello world.pdf','memos:file:application/pdf','report [draft]');
    expect(markdown).toContain('hello%20world.pdf');
    expect(markdown).toContain('report \\[draft\\]');
  });
  it("renders highlights and trims graphemes without cutting formatting", () => {
    const { container } = render(<ReactMarkdown remarkPlugins={[remarkHighlight,[remarkPreview,{limit:4}]]}>{'==重点== **中文👩‍💻后面**'}</ReactMarkdown>);
    expect(container.querySelector('mark')).toHaveTextContent('重点');
    expect(container.textContent).toBe('重点 中');
    expect(visibleCharacterCount('**中文👩‍💻**')).toBe(3);
  });
});
