import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlText = DefaultTreeAdapterTypes.TextNode;

const BLOCK_CLOSE_TAGS = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "table",
  "ul",
  "ol",
  "section",
  "article",
]);

function childNodes(node: HtmlNode): readonly HtmlNode[] {
  return "childNodes" in node ? node.childNodes : [];
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function appendText(node: HtmlNode, parts: string[]): void {
  if (node.nodeName === "#text") {
    parts.push((node as HtmlText).value);
    return;
  }

  if (isElement(node)) {
    if (node.tagName === "script" || node.tagName === "style") {
      parts.push(" ");
      return;
    }
    if (node.tagName === "br") {
      parts.push("\n");
      return;
    }
  }

  for (const child of childNodes(node)) appendText(child, parts);

  if (isElement(node) && BLOCK_CLOSE_TAGS.has(node.tagName)) parts.push("\n");
}

function findElement(node: HtmlNode, tagName: string): HtmlElement | undefined {
  if (isElement(node) && node.tagName === tagName) return node;
  for (const child of childNodes(node)) {
    const match = findElement(child, tagName);
    if (match) return match;
  }
  return undefined;
}

function plainText(node: HtmlNode): string {
  const parts: string[] = [];
  appendText(node, parts);
  return parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Lifts the first `<strong>` run from an HTML alert body as a plain-text title.
 * HTML parsing decodes character references once, so the returned title must
 * not be passed through another HTML recovery step.
 */
export function extractStrongTitle(html: string): string | undefined {
  if (!html.toLowerCase().includes("<strong")) return undefined;
  const document = parseFragment(html);
  const strong = findElement(document, "strong");
  const title = strong ? plainText(strong).replace(/\s+/g, " ").trim() : "";
  return title || undefined;
}

/**
 * Recovers plain text from an HTML alert body with the HTML fragment parser.
 * `<br>` and block boundaries become newlines, inline markup is removed, and
 * character references are decoded once. Plain text remains intact, including
 * comparison signs that do not begin valid HTML tags.
 */
export function stripHtml(html: string): string {
  if (!/[<&\r\0]/u.test(html))
    return html
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  return plainText(parseFragment(html));
}
