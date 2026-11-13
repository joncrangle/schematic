import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = [
  "AGENTS.md",
  "CODING_STANDARDS.md",
  "CONTRIBUTING.md",
  "docs/development.md",
  "docs/add-an-agency.md",
  "docs/add-a-coverage-country.md",
  ...readdirSync(resolve(root, "docs/agency-reference"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/agency-reference/${name}`),
  ...readdirSync(resolve(root, "docs/agents"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/agents/${name}`),
];
const failures: string[] = [];
const headingCache = new Map<string, Set<string>>();

function markdownHeadings(path: string): Set<string> {
  const cached = headingCache.get(path);
  if (cached) return cached;
  const headings = new Set<string>();
  let fence = "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1];
    if (!heading) continue;
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replace(/ /g, "-");
    let anchor = slug;
    for (let suffix = 1; headings.has(anchor); suffix++) anchor = `${slug}-${suffix}`;
    headings.add(anchor);
  }
  headingCache.set(path, headings);
  return headings;
}

for (const file of files) {
  const path = resolve(root, file);
  const contents = readFileSync(path, "utf8");
  for (const match of contents.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
    const href = match[1];
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
    const [location, fragment] = href.split("#");
    const target = location ? resolve(dirname(path), decodeURIComponent(location)) : path;
    const line = contents.slice(0, match.index).split("\n").length;
    const local = relative(root, target);
    if (local === ".." || local.startsWith(`..${sep}`) || !existsSync(target)) {
      failures.push(`${file}:${line}: missing or outside-repository link ${href}`);
    } else if (
      fragment &&
      target.endsWith(".md") &&
      !markdownHeadings(target).has(decodeURIComponent(fragment))
    ) {
      failures.push(`${file}:${line}: missing heading ${href}`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Agent documentation links checked in ${files.length} files.`);
}
