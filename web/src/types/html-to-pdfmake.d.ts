declare module "html-to-pdfmake" {
  import type { Content, StyleDictionary } from "pdfmake/interfaces";

  export default function htmlToPdfmake(html: string, options?: { defaultStyles?: StyleDictionary; removeExtraBlanks?: boolean }): Content;
}
