import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Keeps entry styles from blocking the self-contained document startup screen. */
export const deferStartupStyles = (html: string) =>
  html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (link) => {
    const preload = link.replace('rel="stylesheet"', 'rel="preload" as="style" data-startup-stylesheet');
    return `${preload}<noscript>${link}</noscript>`;
  });

/** Identifies the built document and its content-hashed entry assets without a timestamp. */
export const stampStartupBuild = (html: string, version: string) => {
  const buildId = createHash("sha256").update(`${version}\0${html}`).digest("hex");
  return html.replace('name="memos-build-id" content="__MEMOS_BUILD_ID__"', `name="memos-build-id" content="${buildId}"`);
};

export const startupHtml = (): Plugin => {
  let version: string;
  return {
    name: "memos-startup-html",
    apply: "build",
    configResolved(config) {
      version = JSON.parse(readFileSync(resolve(config.root, "../package.json"), "utf8")).version;
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => stampStartupBuild(deferStartupStyles(html), version),
    },
  };
};
