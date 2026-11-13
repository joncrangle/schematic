import { serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";

type Node = DefaultTreeAdapterTypes.Node;

/** Keep safe source links readable without treating page HTML as trusted. */
export function formatNoticeText(node: Node, source: string): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (!("tagName" in node)) return "";
  if (["script", "style"].includes(node.tagName)) return " ";
  if (node.tagName === "br") return " ";
  if (node.tagName === "a") {
    const label = stripHtml(serializeOuter(node)).replaceAll("[", "").replaceAll("]", "");
    const href = node.attrs.find((attr) => attr.name === "href")?.value;
    try {
      const url = new URL(href ?? "", source);
      if (href && ["https:", "http:"].includes(url.protocol)) {
        return `[${label}](${url.href.replace(/\(/gu, "%28").replace(/\)/gu, "%29")})`;
      }
    } catch {
      /* Keep the visible label when the destination is invalid. */
    }
    return label;
  }
  const text = node.childNodes.map((child) => formatNoticeText(child, source)).join("");
  return ["li", "p"].includes(node.tagName) ? `${text} ` : text;
}
