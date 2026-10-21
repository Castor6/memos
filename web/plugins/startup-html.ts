import type { Plugin } from "vite";

/** Keeps entry styles from blocking the self-contained document startup screen. */
export const deferStartupStyles = (html: string) =>
  html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (link) => {
    const preload = link.replace('rel="stylesheet"', 'rel="preload" as="style" data-startup-stylesheet');
    return `${preload}<noscript>${link}</noscript>`;
  });

export const startupHtml = (): Plugin => ({
  name: "memos-startup-html",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: deferStartupStyles,
  },
});
