import { describe, expect, it } from "vitest";
import { normalizeImageSources } from "../image-sources";

const BASE = "https://example.com/articles/post";
function normalize(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { doc, sources: normalizeImageSources(doc, BASE) };
}

describe("normalizeImageSources", () => {
  it("prefers lazy sources to placeholders, resolves relatives and deduplicates without moving nodes", () => {
    const { doc, sources } = normalize(
      '<p>Before<img src="/placeholder.gif" data-src="../photo.webp"><span>Middle</span><img data-original="/photo.webp">After</p>',
    );
    expect(sources).toEqual(["https://example.com/photo.webp"]);
    expect(Array.from(doc.querySelectorAll("img"), (img) => img.getAttribute("src"))).toEqual([sources[0], sources[0]]);
    expect(doc.querySelector("p")?.children[1]?.tagName).toBe("SPAN");
  });

  it("uses srcset-only and picture sources when no concrete image URL exists", () => {
    const { sources } = normalize(
      '<img srcset="/small.webp 400w, /large.webp 1200w"><picture><source srcset="/picture.avif 1x"><img alt="picture"></picture>',
    );
    expect(sources).toEqual(["https://example.com/large.webp", "https://example.com/picture.avif"]);
  });

  it("rejects executable and unsupported image sources without inventing page URLs", () => {
    const { doc, sources } = normalize(
      '<img><img src="javascript:alert(1)"><img src="blob:https://example.com/id"><img src="data:text/html,hello"><img src="data:image/svg+xml;base64,AAAA"><img data-src="javascript:bad" src="/safe.png">',
    );
    expect(sources).toEqual(["https://example.com/safe.png"]);
    expect(doc.querySelectorAll("img")).toHaveLength(1);
  });
});
