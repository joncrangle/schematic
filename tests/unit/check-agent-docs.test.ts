import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

function checkDocs(contents: string, source = "AGENTS.md") {
  const root = mkdtempSync(join(tmpdir(), "agent-docs-"));
  directories.push(root);
  const fixtures: Record<string, string> = {
    "AGENTS.md": "# Agent guidance\n",
    "CODING_STANDARDS.md": "# Rules\n\n## Shared behavior\n\n## Shared behavior\n",
    "CONTRIBUTING.md": "# Contributing\n",
    "docs/development.md": "# Development\n",
    "docs/add-an-agency.md": "# Agency guide\n",
    "docs/add-a-coverage-country.md": "# Coverage map guide\n",
    "docs/agency-reference/manifest.md": "# Manifest\n",
    "docs/agents/navigation.md": "# Navigation\n",
  };
  fixtures[source] = contents;
  for (const [file, text] of Object.entries(fixtures)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    resolve(import.meta.dirname, "../../scripts/check-agent-docs.ts"),
    join(root, "scripts/check-agent-docs.ts"),
  );
  return spawnSync("bun", [join(root, "scripts/check-agent-docs.ts")], { encoding: "utf8" });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("documentation link validation", () => {
  it("accepts local headings, repeated headings, directories, and external links", () => {
    const result = checkDocs(`# Guidance
[Rules](CODING_STANDARDS.md#shared-behavior)
[Second section](CODING_STANDARDS.md#shared-behavior-1)
[Self](#guidance)
[Directory](docs/agents/)
[External](https://example.invalid/missing#section)
`);
    expect(result.status).toBe(0);
  });

  it.each([
    ["missing.md", "missing or outside-repository link"],
    ["../../outside.md", "missing or outside-repository link"],
    ["CODING_STANDARDS.md#absent", "missing heading"],
    ["#absent", "missing heading"],
  ])("rejects invalid target %s", (href, error) => {
    const result = checkDocs(`[Target](${href})\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });

  it("rejects a heading that appears only inside a fenced example", () => {
    const result = checkDocs("```md\n## Hidden heading\n```\n[Hidden](#hidden-heading)\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing heading");
  });

  it.each([
    "CODING_STANDARDS.md",
    "CONTRIBUTING.md",
    "docs/development.md",
    "docs/add-an-agency.md",
    "docs/add-a-coverage-country.md",
  ])("validates links in %s", (source) => {
    const result = checkDocs("[Missing](missing.md)\n", source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${source}:1:`);
  });
});
