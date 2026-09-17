import Image from "@tiptap/extension-image";
import { FILE_TITLE, fileMarkdown, REFERENCE_TITLE, safeMediaURL } from "@/lib/inline-media";

export const InlineMedia = Image.extend({
  renderMarkdown: (node) => fileMarkdown(node.attrs?.src || "", node.attrs?.title || "", node.attrs?.alt || ""),
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "rich-media";
      dom.contentEditable = "false";
      const render = () => {
        dom.replaceChildren();
        const src = safeMediaURL(node.attrs.src || "");
        const title = String(node.attrs.title || "");
        const label = String(node.attrs.alt || "文件");
        const type = title.startsWith(FILE_TITLE) ? title.slice(FILE_TITLE.length) : "image/";
        if (title === REFERENCE_TITLE) {
          const card = document.createElement("span");
          card.className = "rich-file-card";
          card.textContent = `↗ ${label}`;
          dom.append(card);
        } else if (type.startsWith("video/") || type.startsWith("audio/")) {
          const media = document.createElement(type.startsWith("video/") ? "video" : "audio");
          media.src = src;
          media.controls = true;
          media.preload = "metadata";
          dom.append(media);
        } else if (type.startsWith("image/")) {
          const image = document.createElement("img");
          image.src = src;
          image.alt = label;
          dom.append(image);
        } else {
          const card = document.createElement("span");
          card.className = "rich-file-card";
          card.textContent = `📎 ${label}`;
          dom.append(card);
        }
        if (src.startsWith("blob:")) {
          const status = document.createElement("span");
          status.className = "text-xs text-muted-foreground";
          status.textContent = "上传中…";
          dom.append(status);
        }
      };
      render();
      return {
        dom,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          node = updated;
          render();
          return true;
        },
      };
    };
  },
});
