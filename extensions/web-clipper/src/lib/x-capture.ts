export type CapturedPost = {
  id: string;
  url: string;
  author: string;
  authorName: string;
  content: string;
  publishedAt: string;
  images: string[];
};

export type XCapture = {
  kind: "STAR" | "PICK_UP";
  platform: "X";
  sourceUrl: string;
  sourceId: string;
  comment: string;
  context: string;
  posts: CapturedPost[];
};

export type XCaptureResult = {
  capture: XCapture | null;
  title: string;
  images: string[];
  isOwnPost: boolean | null;
  warnings: string[];
  error?: string;
};

/** Reads the rendered page only. Keep all runtime helpers inside this serializable function. */
export function captureXPage(kind: "STAR" | "CLIP" | "PICK_UP"): XCaptureResult {
  const warnings: string[] = [];
  const fail = (error: string): XCaptureResult => ({ capture: null, title: "", images: [], isOwnPost: null, warnings, error });
  const isXHost = (host: string) => /^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/i.test(host);
  const statusLink = (value: string | null, allowHistory = false) => {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      if (!isXHost(url.hostname) || !/^https?:$/.test(url.protocol)) return null;
      const match = url.pathname.match(/^\/([\w]+)\/status\/(\d+)(?:\/(?:(?:photo|video)\/\d+|(history)))?\/?$/);
      if (!match || (match[3] && !allowHistory)) return null;
      return { id: match[2]!, handle: match[1]!, url: `https://x.com/${match[1]}/status/${match[2]}` };
    } catch {
      return null;
    }
  };
  if (!isXHost(location.hostname)) return fail("本期仅支持 X 帖子，请打开 x.com 上的帖子详情页。");
  const source = statusLink(location.href);
  if (!source) return fail("请先打开一条 X 帖子的详情页，再点击剪藏或 Pick up。");

  const visible = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const quoteRoot = (element: Element, article: Element): Element | null => {
    // Timestamp anchors also have role=link on X. A quote container includes both
    // provenance and a body; walk past the inner timestamp to find that container.
    for (let root: Element | null = element; root && root !== article; root = root.parentElement) {
      if (root.getAttribute("role") !== "link" || !article.contains(root)) continue;
      if (
        root.querySelector('[data-testid="User-Name"]') ||
        (root.querySelector("time[datetime]") && root.querySelector('[data-testid="tweetText"]'))
      )
        return root;
    }
    return null;
  };
  const ownElements = (root: Element, selector: string, article: Element) =>
    Array.from(root.querySelectorAll(selector)).filter(
      (element) => visible(element) && element.closest('article[data-testid="tweet"]') === article && !quoteRoot(element, article),
    );
  const safeHref = (element: Element): string | null => {
    try {
      const url = new URL(element.getAttribute("href") ?? "", location.href);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const escapeLabel = (value: string) => value.replace(/[\\[\]]/g, "\\$&");
  const text = (root: Node): string => {
    if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? "";
    if (!(root instanceof Element) || !visible(root)) return "";
    if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "BUTTON"].includes(root.tagName)) return "";
    if (root.tagName === "BR") return "\n";
    if (root.tagName === "IMG") return root.getAttribute("alt") ?? "";
    const content = Array.from(root.childNodes).map(text).join("");
    if (root.tagName === "A") {
      const href = safeHref(root);
      return href ? `[${escapeLabel(content || href)}](<${href.replace(/>/g, "%3E")}>)` : content;
    }
    return ["P", "DIV"].includes(root.tagName) ? `${content}\n` : content;
  };
  const bodyText = (root: Element) =>
    text(root)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  const mediaImages = (root: Element, article: Element, includeQuote: boolean): string[] => {
    const images = Array.from(root.querySelectorAll('[data-testid="tweetPhoto"] img'))
      .filter((image) => visible(image) && (includeQuote || !quoteRoot(image, article)))
      .map((image) => image.getAttribute("src") ?? "")
      .filter((src) => {
        try {
          const url = new URL(src);
          return url.protocol === "https:" && url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/media/");
        } catch {
          return false;
        }
      });
    return [...new Set(images)];
  };
  const authorName = (header: Element | undefined, handle: string) => {
    if (!header) return `@${handle}`;
    const name = Array.from(header.querySelectorAll("a"))
      .find((link) => {
        try {
          return new URL(link.getAttribute("href") ?? "", location.href).pathname.toLowerCase() === `/${handle.toLowerCase()}`;
        } catch {
          return false;
        }
      })
      ?.textContent?.trim();
    return name || `@${handle}`;
  };
  const readPost = (article: Element): CapturedPost | null => {
    const time = ownElements(article, "time[datetime]", article).find((element) =>
      statusLink(element.closest("a")?.getAttribute("href") ?? null, true),
    );
    const link = statusLink(time?.closest("a")?.getAttribute("href") ?? null, true);
    if (!link) return null;
    const content = ownElements(article, '[data-testid="tweetText"]', article).map(bodyText).join("\n\n");
    const header = ownElements(article, '[data-testid="User-Name"]', article)[0];
    return {
      id: link.id,
      url: link.url,
      author: `@${link.handle}`,
      authorName: authorName(header, link.handle),
      content,
      publishedAt: time?.getAttribute("datetime") ?? "",
      images: mediaImages(article, article, false),
    };
  };
  const primary = document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector("main") ?? document;
  const articles = Array.from(primary.querySelectorAll('article[data-testid="tweet"]')).filter(
    (article) => visible(article) && !article.parentElement?.closest('article[data-testid="tweet"]'),
  );
  const target = articles.find((article) => readPost(article)?.id === source.id);
  if (!target) return fail("未找到当前帖子正文。请等待帖子加载完成，并展开内容后重试。");
  const current = readPost(target)!;

  const quotePosts = (article: Element): CapturedPost[] => {
    const roots = new Set(
      Array.from(article.querySelectorAll('[data-testid="tweetText"], time[datetime]'))
        .map((element) => quoteRoot(element, article))
        .filter((root): root is Element => !!root && visible(root)),
    );
    const posts: CapturedPost[] = [];
    for (const root of roots) {
      const time = root.querySelector("time[datetime]");
      const links = [
        root.getAttribute("href"),
        time?.closest("a")?.getAttribute("href"),
        ...Array.from(root.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")),
      ];
      const link = links.map((href) => statusLink(href ?? null, true)).find(Boolean);
      if (!link) {
        warnings.push("有引用卡片无法确认原帖链接，未将其混入你的评论；请展开引用原帖后核对。");
        continue;
      }
      posts.push({
        id: link.id,
        url: link.url,
        author: `@${link.handle}`,
        authorName: authorName(root.querySelector('[data-testid="User-Name"]') ?? undefined, link.handle),
        content: Array.from(root.querySelectorAll('[data-testid="tweetText"]')).map(bodyText).join("\n\n"),
        publishedAt: time?.getAttribute("datetime") ?? "",
        images: mediaImages(root, article, true),
      });
    }
    return posts;
  };
  const incomplete = (article: Element) => {
    if (article.querySelector('[data-testid="tweet-text-show-more-link"]')) {
      warnings.push("有帖子正文尚未展开，当前只保存已显示的部分；请先展开全文后重新提取。");
    }
    if (article.querySelector('video, [data-testid="videoPlayer"]')) {
      warnings.push("帖子含视频，本次保留帖子链接，不下载视频。");
    }
    if (
      Array.from(article.querySelectorAll('[role="link"]')).some((element) =>
        /^(?:this post (?:is unavailable|was deleted)|此帖子不可用|这条帖子已被删除|此貼文無法查看)/i.test(
          element.textContent?.trim() ?? "",
        ),
      )
    ) {
      warnings.push("有引用内容不可用，当前保存不包含缺失的引用正文。");
    }
  };
  const withQuotes = (post: CapturedPost, quotes: CapturedPost[]): CapturedPost => {
    const quotedContent = quotes.map((quote) => {
      const body = quote.content
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `引用 [${quote.author}](<${quote.url}>)\n\n${body}`;
    });
    return {
      ...post,
      content: [post.content, ...quotedContent].filter(Boolean).join("\n\n"),
      images: [...new Set([...post.images, ...quotes.flatMap((quote) => quote.images)])],
    };
  };
  incomplete(target);
  const quotes = quotePosts(target);
  const posts: CapturedPost[] = [];
  if (kind === "PICK_UP") {
    const region = target.closest('[role="region"]');
    const regionName =
      region?.getAttribute("aria-label") ||
      (region?.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    const conversation = region && /(?:conversation|对话|對話|会话|會話)/i.test(regionName);
    if (conversation) {
      const preceding = articles.filter(
        (article) => region.contains(article) && !!(article.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      let next = current;
      for (let index = preceding.length - 1; index >= 0; index--) {
        const article = preceding[index]!;
        const previous = readPost(article);
        const boundaries = Array.from(region.querySelectorAll('[role="heading"], [role="button"], [data-testid="cellInnerDiv"]')).filter(
          (element) =>
            !element.closest('article[data-testid="tweet"]') &&
            !element.contains(article) &&
            !element.contains(target) &&
            visible(element) &&
            !!(article.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            !!(element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        const hasGap = boundaries.some((element) =>
          /(?:show (?:more|additional) replies|show this thread|discover more|more posts|unavailable|deleted|查看更多回复|显示更多回复|顯示更多回覆|展开对话|顯示此對話|发现更多|探索更多|帖子不可用|推文不可用|已删除)/i.test(
            element.textContent ?? "",
          ),
        );
        if (hasGap || !previous || BigInt(previous.id) >= BigInt(next.id)) {
          warnings.push("对话中存在推荐、折叠、不可用内容或无法确认的帖子顺序，已停止向前提取；上下文可能不完整。");
          break;
        }
        incomplete(article);
        posts.unshift(withQuotes(previous, quotePosts(article)));
        next = previous;
      }
      if (posts.length) warnings.push("已保存页面中展开的上文；X 可能未加载完整对话，请在保存前核对回应对象。");
    }
    for (const quote of quotes) if (!posts.some((post) => post.id === quote.id)) posts.push(quote);
    posts.push(current);
  } else {
    posts.push(withQuotes(current, quotes));
  }
  const profile = Array.from(document.querySelectorAll('a[data-testid="AppTabBar_Profile_Link"]')).find(visible);
  let isOwnPost: boolean | null = null;
  if (profile) {
    try {
      const url = new URL(profile.getAttribute("href") ?? "", location.href);
      const handle = url.pathname.match(/^\/([\w]+)\/?$/)?.[1];
      if (isXHost(url.hostname) && handle) isOwnPost = handle.toLowerCase() === current.author.slice(1).toLowerCase();
    } catch {
      // An unrecognized profile link cannot establish the signed-in user's identity.
    }
  }
  return {
    capture: {
      kind: kind === "PICK_UP" ? "PICK_UP" : "STAR",
      platform: "X",
      sourceUrl: current.url,
      sourceId: current.id,
      comment: kind === "PICK_UP" ? current.content : "",
      context: "",
      posts,
    },
    title: `${current.authorName} (${current.author})`,
    images: [...new Set(posts.flatMap((post) => post.images))],
    isOwnPost,
    warnings: [...new Set(warnings)],
  };
}
