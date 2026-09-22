/** Materialize lazy image URLs before Markdown conversion; never change CDN format parameters. */
export function normalizeImageSources(root: ParentNode, baseUrl: string): string[] {
  const images: string[] = [];
  for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
    const srcset =
      img.getAttribute("data-srcset") ||
      img.getAttribute("srcset") ||
      img.closest("picture")?.querySelector("source[srcset]")?.getAttribute("srcset");
    // Pick the largest explicitly described candidate when there is no concrete source.
    const candidates = srcset
      ?.split(",")
      .map((entry) => {
        const [url, descriptor] = entry.trim().split(/\s+/);
        return { url, size: Number.parseFloat(descriptor || "1") || 1 };
      })
      .sort((a, b) => b.size - a.size);
    const candidateUrls = candidates?.map((candidate) => candidate.url) ?? [];
    const preferCandidates = img.hasAttribute("data-srcset") || /^data:/i.test(img.getAttribute("src") || "");
    const sources = [
      img.getAttribute("data-src"),
      img.getAttribute("data-original"),
      img.getAttribute("data-lazy-src"),
      img.getAttribute("data-url"),
      ...(preferCandidates ? candidateUrls : []),
      img.getAttribute("src"),
      ...candidateUrls,
    ];
    let source: string | undefined;
    for (const raw of sources) {
      if (!raw?.trim()) continue;
      try {
        const url = new URL(raw, baseUrl);
        if (url.protocol === "https:" || url.protocol === "http:" || /^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(url.href)) {
          source = url.href;
          break;
        }
      } catch {
        /* Try the next source on malformed page markup. */
      }
    }
    if (!source) {
      img.remove();
      continue;
    }
    img.setAttribute("src", source);
    // Prevent later extractor heuristics from selecting an unresolved lazy source instead.
    for (const attr of ["srcset", "data-srcset", "data-src", "data-original", "data-lazy-src", "data-url"]) img.removeAttribute(attr);
    images.push(source);
  }
  return [...new Set(images)];
}
