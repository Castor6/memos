import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureXPage } from "@/lib/x-capture";

const post = (id: string, handle: string, content: string, extra = "") => `
  <div data-testid="cellInnerDiv"><article data-testid="tweet">
    <div data-testid="User-Name"><a href="/${handle}"><span>${handle} Name</span></a><span>@${handle}</span></div>
    <div data-testid="tweetText">${content}</div>
    ${extra}
    <a role="link" href="/${handle}/status/${id}"><time datetime="2026-09-22T08:00:00.000Z">Sep 22</time></a>
  </article></div>`;
const quote = (id = "150", handle = "quoted") => `
  <div role="link" tabindex="0">
    <div data-testid="User-Name"><a href="/${handle}">${handle} Name</a></div>
    <a role="link" href="/${handle}/status/${id}"><time datetime="2026-09-21T08:00:00.000Z">Sep 21</time></a>
    <div data-testid="tweetText">Quoted idea</div>
    <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quote.jpg" alt="Quoted image"></div>
  </div>`;
const page = (content: string, label = "Timeline: Conversation", profile = "me") => {
  document.body.innerHTML = `
    <nav>${profile ? `<a data-testid="AppTabBar_Profile_Link" href="/${profile}">Profile</a>` : ""}</nav>
    <main><div data-testid="primaryColumn"><section role="region" aria-label="${label}">${content}</section></div></main>`;
};

describe("captureXPage", () => {
  beforeEach(() => {
    vi.stubGlobal("location", new URL("https://x.com/me/status/300"));
    document.body.innerHTML = "";
  });

  it("captures the current reply and preceding conversation, excluding subsequent replies and other regions", () => {
    page(
      post("100", "root", "Original") +
        post("200", "parent", "well this paid off :)") +
        post("300", "me", "我的看法") +
        post("400", "other", "Later reply"),
    );
    document.body.insertAdjacentHTML(
      "beforeend",
      `<aside role="region" aria-label="Trending">${post("50", "unrelated", "Unrelated")}</aside>`,
    );
    const result = captureXPage("PICK_UP");
    expect(result.capture).toMatchObject({
      kind: "PICK_UP",
      platform: "X",
      sourceId: "300",
      sourceUrl: "https://x.com/me/status/300",
      comment: "我的看法",
      context: "",
    });
    expect(result.capture?.posts.map(({ id }) => id)).toEqual(["100", "200", "300"]);
    expect(result.capture?.posts[2]).toMatchObject({ author: "@me", authorName: "me Name", publishedAt: "2026-09-22T08:00:00.000Z" });
    expect(result.isOwnPost).toBe(true);
    expect(result.warnings.join(" ")).toContain("可能未加载完整对话");
  });

  it.each(["STAR", "PICK_UP"] as const)("captures an edited post with a history timestamp in %s mode", (kind) => {
    page(post("300", "me", "Edited body").replace('status/300"', 'status/300/history"'));
    const result = captureXPage(kind);
    expect(result.error).toBeUndefined();
    expect(result.capture?.sourceUrl).toBe("https://x.com/me/status/300");
    expect(result.capture?.posts[0]).toMatchObject({
      id: "300",
      url: "https://x.com/me/status/300",
      content: "Edited body",
      author: "@me",
      publishedAt: "2026-09-22T08:00:00.000Z",
    });
    expect(result.isOwnPost).toBe(true);
  });

  it("keeps edited ancestors and quotes attributed to their canonical posts", () => {
    page(
      post("200", "parent", "Edited parent").replace('status/200"', 'status/200/history"') +
        post("300", "me", "My reply", quote().replace('status/150"', 'status/150/history"')),
    );
    const result = captureXPage("PICK_UP");
    expect(result.capture?.posts.map(({ url }) => url)).toEqual([
      "https://x.com/parent/status/200",
      "https://x.com/quoted/status/150",
      "https://x.com/me/status/300",
    ]);
    expect(result.capture?.comment).toBe("My reply");
  });

  it("does not treat the edit-history page as a current post detail", () => {
    vi.stubGlobal("location", new URL("https://x.com/me/status/300/history"));
    page(post("300", "me", "Old revision"));
    expect(captureXPage("PICK_UP").capture).toBeNull();
  });

  it("keeps short posts, line breaks, links, emoji text, and only actual post media", () => {
    page(
      post(
        "300",
        "me",
        '好<br>Read <a href="https://example.com/essay">essay</a> <img src="https://abs.twimg.com/emoji.svg" alt="👍">',
        `
      <img src="https://pbs.twimg.com/profile_images/avatar.jpg" alt="Avatar">
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/photo.jpg?name=small" alt="Image"></div>
      <div data-testid="tweetPhoto"><img src="https://untrusted.example/media/photo.jpg" alt="Untrusted"></div>`,
      ),
    );
    const result = captureXPage("STAR");
    expect(result.capture?.comment).toBe("");
    expect(result.capture?.kind).toBe("STAR");
    expect(result.capture?.posts).toHaveLength(1);
    expect(result.capture?.posts[0]?.content).toBe("好\nRead [essay](<https://example.com/essay>) 👍");
    expect(result.images).toEqual(["https://pbs.twimg.com/media/photo.jpg?name=small"]);
  });

  it("reads the conversation label through aria-labelledby as rendered on X", () => {
    page(post("100", "root", "Original") + post("200", "parent", "Reply") + post("300", "me", "My reply"));
    const region = document.querySelector('[role="region"]')!;
    region.removeAttribute("aria-label");
    region.setAttribute("aria-labelledby", "conversation-heading");
    region.insertAdjacentHTML("afterbegin", '<h1 id="conversation-heading">对话</h1>');
    const result = captureXPage("PICK_UP");
    expect(result.capture?.posts.map((post) => post.id)).toEqual(["100", "200", "300"]);
    expect(result.isOwnPost).toBe(true);
  });

  it("normalizes twitter URLs and accepts the earlier CLIP input as Star", () => {
    vi.stubGlobal("location", new URL("https://mobile.twitter.com/me/status/300/photo/1?ref=share"));
    page(post("300", "me", "Short"));
    expect(captureXPage("CLIP").capture).toMatchObject({ kind: "STAR", sourceUrl: "https://x.com/me/status/300" });
  });

  it.each([
    "https://x.com.evil.example/me/status/300",
    "https://example.com/me/status/300",
    "https://x.com/home",
  ])("rejects unsupported page %s", (url) => {
    vi.stubGlobal("location", new URL(url));
    page(post("300", "me", "Should not capture"));
    expect(captureXPage("PICK_UP").capture).toBeNull();
    expect(captureXPage("PICK_UP").error).toBeTruthy();
  });

  it("does not mistake a quoted status for the current page's main post", () => {
    page(post("400", "someone", "Another post", quote("300", "me")));
    expect(captureXPage("PICK_UP").capture).toBeNull();
  });

  it("separates a quoted post from the user's words, with complete source metadata", () => {
    page(post("300", "me", "My response", quote()));
    const result = captureXPage("PICK_UP");
    expect(result.capture?.comment).toBe("My response");
    expect(result.capture?.posts.map(({ id }) => id)).toEqual(["150", "300"]);
    expect(result.capture?.posts[0]).toMatchObject({ content: "Quoted idea", author: "@quoted", publishedAt: "2026-09-21T08:00:00.000Z" });
    expect(result.capture?.posts[1]?.content).toBe("My response");
    expect(result.images).toEqual(["https://pbs.twimg.com/media/quote.jpg"]);
  });

  it("marks quoted content clearly in Star without mixing it into personal commentary", () => {
    page(post("300", "me", "My response", quote()));
    const result = captureXPage("STAR");
    expect(result.capture?.posts).toHaveLength(1);
    expect(result.capture?.posts[0]?.content).toBe("My response\n\n引用 [@quoted](<https://x.com/quoted/status/150>)\n\n> Quoted idea");
    expect(result.capture?.comment).toBe("");
  });

  it("retains a quoted source inside an ancestor post", () => {
    page(post("200", "parent", "Parent response", quote()) + post("300", "me", "My response"));
    const result = captureXPage("PICK_UP");
    expect(result.capture?.posts[0]?.content).toContain("引用 [@quoted](<https://x.com/quoted/status/150>)");
    expect(result.capture?.comment).toBe("My response");
    expect(result.images).toEqual(["https://pbs.twimg.com/media/quote.jpg"]);
  });

  it("does not mix a quote with an unrecognized header or missing link into the user's words", () => {
    page(post("300", "me", "My response", quote().replace('data-testid="User-Name"', 'data-testid="changed-header"')));
    expect(captureXPage("PICK_UP").capture?.comment).toBe("My response");
    page(post("300", "me", "My response", quote().replace("/quoted/status/150", "/quoted")));
    const result = captureXPage("PICK_UP");
    expect(result.capture?.comment).toBe("My response");
    expect(result.warnings.join(" ")).toContain("无法确认原帖链接");
  });

  it("reports unavailable quoted content and videos without attempting to fetch them", () => {
    page(
      post("300", "me", "My response", '<div role="link">This post was deleted.</div><div data-testid="videoPlayer"><video></video></div>'),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = captureXPage("PICK_UP");
    expect(result.capture?.comment).toBe("My response");
    expect(result.warnings.join(" ")).toContain("引用内容不可用");
    expect(result.warnings.join(" ")).toContain("不下载视频");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not filter preceding posts by advertisement markers", () => {
    page(
      post("100", "root", "Original") +
        post("200", "ad", "Product", '<span data-testid="promotedIndicator">Promoted</span>') +
        post("300", "me", "Response"),
    );
    const result = captureXPage("PICK_UP");
    expect(result.capture?.posts.map(({ id }) => id)).toEqual(["100", "200", "300"]);
    expect(result.warnings.join(" ")).not.toContain("已停止向前提取");
  });

  it("captures a video ancestor wrapped in placementTracking without fetching media", () => {
    page(
      post(
        "200",
        "parent",
        "Video introduction",
        '<div data-testid="placementTracking"><div data-testid="videoPlayer"><video src="blob:https://x.com/example"></video></div></div>',
      ) + post("300", "me", "My response"),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = captureXPage("PICK_UP");
    expect(result.capture?.posts.map(({ id }) => id)).toEqual(["200", "300"]);
    expect(result.capture?.posts[0]).toMatchObject({ content: "Video introduction", url: "https://x.com/parent/status/200" });
    expect(result.warnings.join(" ")).toContain("不下载视频");
    expect(result.warnings.join(" ")).not.toContain("已停止向前提取");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["STAR", "PICK_UP"] as const)("captures the current post inside tracking wrappers in %s mode", (mode) => {
    page(
      `<div data-testid="placementTracking">${post("300", "me", "Current video", '<div data-testid="placementTracking"><div data-testid="videoPlayer"><video></video></div></div>')}</div>`,
    );
    const result = captureXPage(mode);
    expect(result.error).toBeUndefined();
    expect(result.capture?.posts[0]).toMatchObject({ id: "300", content: "Current video" });
    expect(result.warnings.join(" ")).toContain("不下载视频");
  });

  it("does not treat the word Ad in post text as an advertisement", () => {
    page(post("300", "me", "<span>Ad</span>"));
    expect(captureXPage("STAR").capture?.posts[0]?.content).toBe("Ad");
  });

  it.each(["Show more replies", "Discover more", "查看更多回复", "帖子不可用"])("does not cross the %s boundary", (label) => {
    page(
      post("100", "unrelated", "Unrelated") +
        `<div data-testid="cellInnerDiv"><div role="heading">${label}</div></div>` +
        post("200", "parent", "Parent") +
        post("300", "me", "Response"),
    );
    const result = captureXPage("PICK_UP");
    expect(result.capture?.posts.map(({ id }) => id)).toEqual(["200", "300"]);
    expect(result.warnings.join(" ")).toContain("上下文可能不完整");
  });

  it("does not infer ancestors from a home timeline or from newer posts", () => {
    page(post("100", "unrelated", "Unrelated") + post("300", "me", "Response"), "Timeline: Home");
    expect(captureXPage("PICK_UP").capture?.posts.map(({ id }) => id)).toEqual(["300"]);
    page(post("400", "newer", "Newer") + post("300", "me", "Response"));
    expect(captureXPage("PICK_UP").capture?.posts.map(({ id }) => id)).toEqual(["300"]);
  });

  it("reports truncated text without treating missing context as an error", () => {
    page(post("300", "me", "Only visible part", '<button data-testid="tweet-text-show-more-link">Show more</button>'));
    const result = captureXPage("PICK_UP");
    expect(result.capture?.comment).toBe("Only visible part");
    expect(result.warnings.join(" ")).toContain("正文尚未展开");
    expect(result.warnings).toHaveLength(1);
  });

  it.each(["时间线：对话", "Timeline: Home"])("captures standalone posts without missing-context warnings in %s", (region) => {
    page(post("300", "me", "My own post"), region);
    const result = captureXPage("PICK_UP");
    expect(result.capture?.posts.map(({ id }) => id)).toEqual(["300"]);
    expect(result.capture?.comment).toBe("My own post");
    expect(result.warnings).toEqual([]);
  });

  it("distinguishes another author's post from a missing signed-in identity", () => {
    page(post("300", "me", "Post"), "时间线：对话", "someone");
    expect(captureXPage("PICK_UP").isOwnPost).toBe(false);
    page(post("300", "me", "Post"), "时间线：对话", "");
    expect(captureXPage("PICK_UP").isOwnPost).toBeNull();
  });

  it("ignores hidden duplicates and never evaluates page scripts or event handlers", () => {
    page(
      `<div hidden>${post("300", "me", "Hidden duplicate")}</div>` +
        post(
          "300",
          "me",
          '<script>globalThis.captureExecuted = true</script><a href="javascript:globalThis.captureExecuted=true">Safe text</a>',
          '<img onerror="globalThis.captureExecuted = true" src="invalid">',
        ),
    );
    const result = captureXPage("STAR");
    expect(result.capture?.posts[0]?.content).toBe("Safe text");
    expect((globalThis as Record<string, unknown>).captureExecuted).toBeUndefined();
  });

  it("works after serialization with no imported or closure-bound runtime helpers", () => {
    page(post("300", "me", "Serializable"));
    const injected = new Function(`return (${captureXPage.toString()})`)() as typeof captureXPage;
    expect(injected("PICK_UP").capture?.comment).toBe("Serializable");
  });
});
