import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
function elements(node: Node): Element[] {
  return [
    ...("tagName" in node ? [node] : []),
    ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
  ];
}
function text(node: Node): string {
  return stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
}
function matches(text: string, alias: string): boolean {
  return text.toLowerCase().includes(alias.toLowerCase());
}
function isNormal(text: string): boolean {
  return /^(Normal métro service|Service normal du métro|All elevators are in service|Tous les ascenseurs sont en service|Normal elevator service|Service normal des ascenseurs)\.?$/iu.test(
    text,
  );
}

/** Server-rendered status components must each contain notices or an explicit normal marker. */
export function componentServiceStatus(
  html: string,
  routeNames: Readonly<Record<string, readonly string[]>>,
  stopNames: Readonly<Record<string, readonly string[]>>,
) {
  const boards = elements(parse(html)).filter((el) =>
    el.attrs.some((a) => a.name === "id" && a.value.endsWith("-service-status-content")),
  );
  if (!boards.length) return undefined;
  const result = new Map<
    string,
    { title: string; description: string; routes: string[]; stops: string[]; effect?: string }
  >();
  for (const board of boards) {
    const rows = elements(board).filter((el) => el.tagName === "li");
    if (!rows.length) {
      if (isNormal(text(board))) continue;
      throw new Error("Unrecognized empty status component");
    }
    for (const row of rows) {
      const descendants = elements(row);
      const paragraphs = [
        ...new Set(
          descendants
            .filter((el) => el.tagName === "p")
            .map(text)
            .filter(Boolean),
        ),
      ];
      const plain = paragraphs.join("\n");
      if (!plain) throw new Error("Empty service status row");
      if (isNormal(plain)) continue;
      const imageLabels = descendants
        .flatMap((el) =>
          el.attrs.filter((a) => el.tagName === "img" && a.name === "alt").map((a) => a.value),
        )
        .join(" ");
      const routes = Object.entries(routeNames)
        .filter(([, names]) => names.some((n) => matches(imageLabels, n)))
        .map(([id]) => id);
      const stops = Object.entries(stopNames)
        .filter(([, names]) => names.some((n) => matches(plain, n)))
        .map(([id]) => id);
      if (!routes.length && !stops.length) throw new Error("Unmapped service status row");
      const title = paragraphs[0]!;
      const description = paragraphs.slice(1).join("\n") || title;
      result.set(plain, {
        title,
        description,
        routes,
        stops,
        ...(/\b(elevator|ascenseur)\b/iu.test(plain) ? { effect: "ACCESSIBILITY_ISSUE" } : {}),
      });
    }
  }
  return [...result.values()];
}
