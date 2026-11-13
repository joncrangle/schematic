import { describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import {
  buildMultiSelectLines,
  buildSingleSelectLines,
  clipLine,
  promptMultiSelect,
  PromptCancelledError,
  formatSelectionSummary,
  multiSelectActionForKey,
  reduceMultiSelect,
  resolveWindow,
  visibleMultiSelectRows,
  type MultiSelectState,
  type SelectOption,
} from "../../scripts/lib/mini-tui";

const onAgencies = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
const natAgencies = ["India", "Juliet", "Kilo", "Lima"];

const options: SelectOption[] = [
  { id: "all", label: "All agencies", checked: true },
  { id: "group:ca/on", label: "CA — ON", isHeader: true, group: "ca/on" },
  ...onAgencies.map((label): SelectOption => ({
    id: label.toLowerCase(),
    label,
    group: "ca/on",
    indent: 1,
    checked: true,
  })),
  { id: "group:ca/nat", label: "CA — NAT", isHeader: true, group: "ca/nat" },
  ...natAgencies.map((label): SelectOption => ({
    id: label.toLowerCase(),
    label,
    group: "ca/nat",
    indent: 1,
    checked: true,
  })),
];

const allIds = [...onAgencies, ...natAgencies].map((label) => label.toLowerCase());

function makeState(overrides: Partial<MultiSelectState> = {}): MultiSelectState {
  return {
    cursor: 0,
    selected: new Set(allIds),
    filter: "",
    filterEditing: false,
    collapsed: new Set(),
    ...overrides,
  };
}

function plain(lines: readonly string[]): string {
  return stripVTControlCharacters(lines.join("\n"));
}

describe("clipLine", () => {
  it.each([
    ["界".repeat(10), 10, "界界界界…"],
    ["😀x", 2, "…"],
    ["e\u0301x", 1, "…"],
    ["e\u0301", 1, "e\u0301"],
    ["👩‍💻abcd", 4, "👩‍💻a…"],
  ])("clips %s to %i cells without breaking graphemes", (text, columns, expected) => {
    expect(stripVTControlCharacters(clipLine(text, columns))).toBe(expected);
  });
});

describe("resolveWindow", () => {
  it.each([
    [0, 40, 10],
    [39, 40, 10],
    [5, 40, 3],
    [15, 16, 1],
  ])("keeps cursor %i visible within a %i-row list and %i-row budget", (cursor, total, budget) => {
    const slice = resolveWindow(cursor, total, budget);
    const overhead = (slice.moreAbove > 0 ? 1 : 0) + (slice.moreBelow > 0 ? 1 : 0);
    expect(slice.end - slice.start + overhead).toBeLessThanOrEqual(budget);
    expect(cursor).toBeGreaterThanOrEqual(slice.start);
    expect(cursor).toBeLessThan(slice.end);
  });

  it("reports both scroll directions in the middle of a long list", () => {
    const slice = resolveWindow(20, 40, 10);
    expect(slice.moreAbove).toBeGreaterThan(0);
    expect(slice.moreBelow).toBeGreaterThan(0);
  });
});

describe("buildMultiSelectLines", () => {
  it.each([1, 2, 3, 4, 5, 6, 7])("fits even a %i-row pane", (rows) => {
    const lines = buildMultiSelectLines("Pick agencies", options, makeState({ cursor: 5 }), {
      rows,
      columns: 80,
    });
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(plain(lines)).toContain("Delta");
  });

  it("fits a 15-row list into a short terminal and points at the hidden rows", () => {
    const lines = buildMultiSelectLines("Pick agencies", options, makeState(), {
      rows: 12,
      columns: 80,
    });
    const text = plain(lines);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(text).toContain("more below");
    expect(text).not.toContain("more above");
    expect(text).toContain("12 of 12 selected");
  });

  it("shows rows above once the cursor reaches the end", () => {
    const rows = visibleMultiSelectRows(options, makeState());
    const lines = buildMultiSelectLines(
      "Pick agencies",
      options,
      makeState({ cursor: rows.length - 1 }),
      { rows: 12, columns: 80 },
    );
    const text = plain(lines);
    expect(text).toContain("more above");
    expect(text).not.toContain("more below");
  });

  it("clips every line to the terminal width instead of wrapping", () => {
    const wide: SelectOption[] = [
      ...options,
      {
        id: "extra",
        label: "An Extremely Long Agency Name That Would Wrap On A Narrow Terminal",
        group: "ca/on",
        indent: 1,
      },
    ];
    const lines = buildMultiSelectLines(
      "Pick agencies from a title long enough to need clipping",
      wide,
      makeState({ filter: "a" }),
      { rows: 20, columns: 40 },
    );
    for (const line of lines) {
      expect(stripVTControlCharacters(line).length).toBeLessThanOrEqual(40);
    }
  });

  it("keeps the select-all label readable in a narrow pane", () => {
    const lines = buildMultiSelectLines("Pick agencies", options, makeState(), {
      rows: 20,
      columns: 30,
    });
    expect(plain(lines)).toContain("All agencies (12/12)");
  });

  it("renders an empty state when nothing matches the filter", () => {
    const lines = buildMultiSelectLines("Pick agencies", options, makeState({ filter: "zzz" }), {
      rows: 20,
      columns: 80,
    });
    expect(plain(lines)).toContain('No options match "zzz"');
  });

  it("describes the select-all row by what a filter actually leaves in scope", () => {
    const lines = buildMultiSelectLines("Pick agencies", options, makeState({ filter: "alpha" }), {
      rows: 20,
      columns: 100,
    });
    const text = plain(lines);
    expect(text).toContain("All matching agencies (1/1)");
    expect(text).toContain("CA — ON (1/1)");
    expect(text).not.toContain("All agencies");
  });

  it("shows the matching and total counts while a filter is active", () => {
    const lines = buildMultiSelectLines("Pick agencies", options, makeState({ filter: "hotel" }), {
      rows: 20,
      columns: 100,
    });
    expect(plain(lines)).toContain('1/1 matching · 12/12 total · filter: "hotel"');
  });

  it("describes the select-all row by what a collapsed region leaves in scope", () => {
    const lines = buildMultiSelectLines(
      "Pick agencies",
      options,
      makeState({ collapsed: new Set(["ca/on"]) }),
      { rows: 20, columns: 100 },
    );
    expect(plain(lines)).toContain("All visible agencies (4/4)");
  });

  it("hides the collapsed marker while a filter reveals that region", () => {
    const lines = buildMultiSelectLines(
      "Pick agencies",
      options,
      makeState({ collapsed: new Set(["ca/on"]), filter: "alpha" }),
      { rows: 20, columns: 100 },
    );
    const text = plain(lines);
    expect(text).not.toContain("▸");
    expect(text).toContain("Alpha");
  });
});

describe("visibleMultiSelectRows", () => {
  it("keeps only matching members and their group header", () => {
    const rows = visibleMultiSelectRows(options, makeState({ filter: "hotel" }));
    expect(rows.map((row) => String(row.id))).toEqual(["all", "group:ca/on", "hotel"]);
  });

  it("matches on the group path so a whole region can be filtered in", () => {
    const rows = visibleMultiSelectRows(options, makeState({ filter: "ca/nat" }));
    expect(rows.map((row) => String(row.id))).toEqual([
      "all",
      "group:ca/nat",
      ...natAgencies.map((label) => label.toLowerCase()),
    ]);
  });

  it("hides collapsed members but keeps the header", () => {
    const rows = visibleMultiSelectRows(options, makeState({ collapsed: new Set(["ca/on"]) }));
    const ids = rows.map((row) => String(row.id));
    expect(ids).toContain("group:ca/on");
    expect(ids).not.toContain("alpha");
    expect(ids).toContain("india");
  });

  it("searches through collapsed groups", () => {
    const rows = visibleMultiSelectRows(
      options,
      makeState({ collapsed: new Set(["ca/on"]), filter: "alpha" }),
    );
    expect(rows.map((row) => String(row.id))).toContain("alpha");
  });
});

describe("reduceMultiSelect", () => {
  it("toggles the first agency when Tab follows opening the filter", () => {
    const open = multiSelectActionForKey("/", { name: "/" }, false);
    if (!open) throw new Error("Expected open-filter action");
    const opened = reduceMultiSelect(options, makeState(), open);
    if (opened.kind !== "state") throw new Error("Expected state");
    const tab = multiSelectActionForKey("\t", { name: "tab" }, opened.state.filterEditing);
    if (!tab) throw new Error("Expected toggle action");
    const toggled = reduceMultiSelect(options, opened.state, tab);
    if (toggled.kind !== "state") throw new Error("Expected state");
    expect([...toggled.state.selected]).toEqual(allIds.filter((id) => id !== "alpha"));
  });

  it("toggles only the filtered rows for toggle-all", () => {
    const outcome = reduceMultiSelect(options, makeState({ filter: "alpha" }), {
      type: "toggle-all",
    });
    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect([...outcome.state.selected]).toEqual(allIds.filter((id) => id !== "alpha"));
  });

  it("inverts only the filtered rows", () => {
    const outcome = reduceMultiSelect(
      options,
      makeState({ filter: "alpha", selected: new Set(["bravo"]) }),
      { type: "invert" },
    );
    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect([...outcome.state.selected].sort()).toEqual(["alpha", "bravo"]);
  });

  it("toggles every member when the group header is toggled", () => {
    const rows = visibleMultiSelectRows(options, makeState());
    const headerIndex = rows.findIndex((row) => String(row.id) === "group:ca/on");
    const outcome = reduceMultiSelect(options, makeState({ cursor: headerIndex }), {
      type: "toggle",
    });
    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect([...outcome.state.selected].sort()).toEqual(
      natAgencies.map((label) => label.toLowerCase()).sort(),
    );
  });

  it("toggles only matching members when a group header is toggled under a filter", () => {
    const state = makeState({ filter: "alpha" });
    const rows = visibleMultiSelectRows(options, state);
    const headerIndex = rows.findIndex((row) => String(row.id) === "group:ca/on");
    const outcome = reduceMultiSelect(
      options,
      { ...state, cursor: headerIndex },
      {
        type: "toggle",
      },
    );
    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect([...outcome.state.selected]).toEqual(allIds.filter((id) => id !== "alpha"));
  });

  it("collapses the group that owns the cursor row", () => {
    const rows = visibleMultiSelectRows(options, makeState());
    const memberIndex = rows.findIndex((row) => String(row.id) === "bravo");
    const outcome = reduceMultiSelect(options, makeState({ cursor: memberIndex }), {
      type: "collapse",
    });
    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect([...outcome.state.collapsed]).toEqual(["ca/on"]);
    expect(visibleMultiSelectRows(options, outcome.state)[outcome.state.cursor].id).toBe(
      "group:ca/on",
    );
    const expanded = reduceMultiSelect(options, outcome.state, { type: "expand" });
    expect(expanded.kind).toBe("state");
    if (expanded.kind !== "state") throw new Error("Expected expanded state");
    expect(expanded.state.collapsed.size).toBe(0);
  });

  it("clears an active filter before cancelling the prompt", () => {
    expect(
      reduceMultiSelect(options, makeState({ filter: "alpha" }), { type: "cancel" }).kind,
    ).toBe("state");
    expect(reduceMultiSelect(options, makeState(), { type: "cancel" }).kind).toBe("cancel");
  });

  it("submits the selection in option order regardless of toggle order", () => {
    const outcome = reduceMultiSelect(
      options,
      makeState({ selected: new Set(["lima", "alpha"]) }),
      { type: "submit" },
    );
    expect(outcome).toEqual({ kind: "submit", ids: ["alpha", "lima"] });
  });

  it("scopes the submission to the active filter", () => {
    const outcome = reduceMultiSelect(options, makeState({ filter: "hotel" }), {
      type: "submit",
    });
    expect(outcome).toEqual({ kind: "submit", ids: ["hotel"] });
  });

  it("submits nothing when the active filter matches nothing", () => {
    const outcome = reduceMultiSelect(options, makeState({ filter: "zzz" }), {
      type: "submit",
    });
    expect(outcome).toEqual({ kind: "submit", ids: [] });
  });

  it("lands the cursor on the first match while the filter is typed", () => {
    const outcome = reduceMultiSelect(options, makeState(), {
      type: "filter-text",
      text: "hot",
    });
    expect(outcome.kind).toBe("state");
    if (outcome.kind !== "state") return;
    expect(visibleMultiSelectRows(options, outcome.state)[outcome.state.cursor].id).toBe("hotel");
  });

  it("toggles the highlighted match without leaving the filter", () => {
    const typed = reduceMultiSelect(options, makeState(), { type: "filter-text", text: "hot" });
    if (typed.kind !== "state") throw new Error("Expected state");
    const toggled = reduceMultiSelect(options, typed.state, { type: "toggle" });
    if (toggled.kind !== "state") throw new Error("Expected state");
    expect(toggled.state.filterEditing).toBe(true);
    expect(toggled.state.selected.has("hotel")).toBe(false);
    expect(toggled.state.selected.has("alpha")).toBe(true);
  });

  it("seeds only the agency matched by a typed filter", () => {
    let state = makeState();
    const press = (text: string, key: { name: string }) => {
      const action = multiSelectActionForKey(text, key, state.filterEditing);
      if (!action) throw new Error(`No action for ${text}`);
      const outcome = reduceMultiSelect(options, state, action);
      if (outcome.kind !== "state") throw new Error("Expected state");
      state = outcome.state;
    };
    press("/", { name: "/" });
    for (const char of "hot") press(char, { name: char });
    press("\r", { name: "return" });
    expect(reduceMultiSelect(options, state, { type: "submit" })).toEqual({
      kind: "submit",
      ids: ["hotel"],
    });
  });
});

describe("multiSelectActionForKey", () => {
  it("only starts filtering after slash, not on a bare letter", () => {
    expect(multiSelectActionForKey("t", { name: "t" }, false)).toBeNull();
    expect(multiSelectActionForKey("t", { name: "t" }, true)).toEqual({
      type: "filter-text",
      text: "t",
    });
  });

  it("keeps j and k as movement outside the filter box", () => {
    expect(multiSelectActionForKey("j", { name: "j" }, false)).toEqual({
      type: "move",
      delta: 1,
    });
    expect(multiSelectActionForKey("j", { name: "j" }, true)).toEqual({
      type: "filter-text",
      text: "j",
    });
  });

  it("toggles with tab in and out of the filter box", () => {
    expect(multiSelectActionForKey("\t", { name: "tab" }, false)).toEqual({ type: "toggle" });
    expect(multiSelectActionForKey("\t", { name: "tab" }, true)).toEqual({ type: "toggle" });
  });

  it("opens the filter with slash and leaves it with enter", () => {
    expect(multiSelectActionForKey("/", { name: "/" }, false)).toEqual({
      type: "open-filter",
    });
    expect(multiSelectActionForKey("\r", { name: "return" }, true)).toEqual({
      type: "close-filter",
    });
  });

  it("reverts the filter with escape instead of quitting", () => {
    expect(multiSelectActionForKey("\x1b", { name: "escape" }, true)).toEqual({
      type: "revert-filter",
    });
    expect(multiSelectActionForKey("\x1b", { name: "escape" }, false)).toEqual({
      type: "cancel",
    });
  });

  it("collapses and expands with bracket keys as well as arrows", () => {
    expect(multiSelectActionForKey("[", { name: "[" }, false)).toEqual({ type: "collapse" });
    expect(multiSelectActionForKey("]", { name: "]" }, false)).toEqual({ type: "expand" });
    expect(multiSelectActionForKey("\x1b[D", { name: "left" }, false)).toEqual({
      type: "collapse",
    });
    expect(multiSelectActionForKey("\x1b[C", { name: "right" }, false)).toEqual({
      type: "expand",
    });
  });
});

describe("formatSelectionSummary", () => {
  it("collapses a partial selection into counts and grouped totals", () => {
    const lines = formatSelectionSummary(
      "Pick agencies",
      options,
      ["alpha", "hotel"],
      "agency",
      "agencies",
    );
    const text = plain(lines);
    expect(text).toContain("2 of 12 agencies");
    expect(text).toContain("CA — ON 2/8");
    expect(text).toContain("CA — NAT 0/4");
    expect(text).toContain("alpha, hotel");
  });

  it("names the full selection without listing every agency", () => {
    const text = plain(
      formatSelectionSummary("Pick agencies", options, allIds, "agency", "agencies"),
    );
    expect(text).toContain("all 12 agencies");
    expect(text).not.toContain("alpha, bravo");
  });
});

describe("buildSingleSelectLines", () => {
  it.each([1, 2, 3, 4, 5])("keeps the focused choice in a %i-row pane", (rows) => {
    const lines = buildSingleSelectLines("Pick target", options, 5, { rows, columns: 30 });
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(plain(lines)).toContain("Delta");
  });

  it("windows long contract lists and keeps the footer visible", () => {
    const targets: SelectOption[] = Array.from({ length: 20 }, (_, index) => ({
      id: `target-${index}`,
      label: `Target ${index}`,
    }));
    const lines = buildSingleSelectLines("Pick target", targets, 19, {
      rows: 10,
      columns: 60,
    });
    const text = plain(lines);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(text).toContain("more above");
    expect(text).toContain("Enter accept");
  });
});

describe("prompt terminal lifecycle", () => {
  it.each(["accept", "cancel", "SIGTERM", "SIGHUP", "SIGINT"])(
    "restores the terminal after resize and %s",
    async (outcome) => {
      const properties = [
        [process.stdin, "isTTY", true],
        [process.stdin, "setRawMode", vi.fn()],
        [process.stdout, "isTTY", true],
        [process.stdout, "rows", 24],
        [process.stdout, "columns", 80],
      ] as const;
      const descriptors = properties.map(([object, key]) =>
        Object.getOwnPropertyDescriptor(object, key),
      );
      const output: string[] = [];
      const rawMode = properties[1][2];
      const wasRaw = process.stdin.isRaw ?? false;
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: unknown, callback?: unknown) => {
          output.push(String(chunk));
          if (typeof callback === "function") callback();
          return true;
        });
      const resume = vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
      const pause = vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
      const listeners = process.stdout.listenerCount("resize");
      try {
        for (const [object, key, value] of properties) {
          Object.defineProperty(object, key, { configurable: true, value });
        }
        const pending = promptMultiSelect("Pick agencies", options);
        const settled = pending.then(
          (ids) => ids,
          (error: unknown) => error,
        );
        Object.defineProperty(process.stdout, "rows", { configurable: true, value: 3 });
        Object.defineProperty(process.stdout, "columns", { configurable: true, value: 20 });
        process.stdout.emit("resize");
        const frame = output.at(-1)?.split("\x1B[H\x1B[2J")[1];
        expect(frame?.split("\r\n").length).toBeLessThanOrEqual(3);
        const signal = outcome.startsWith("SIG");
        if (signal) process.emit(outcome, outcome);
        else
          process.stdin.emit("keypress", outcome === "accept" ? "\r" : "\x03", {
            name: outcome === "accept" ? "return" : "c",
            ctrl: outcome === "cancel",
          });
        const result = signal ? null : await settled;
        expect(result instanceof Error ? result.constructor : result).toEqual(
          signal ? null : outcome === "accept" ? allIds : PromptCancelledError,
        );
        expect(kill.mock.calls).toEqual(signal ? [[process.pid, outcome]] : []);
        expect(rawMode.mock.calls).toEqual([[true], [wasRaw]]);
        expect(output.join("")).toContain("\x1B[?1049h");
        expect(output.join("")).toContain("\x1B[?25h\x1B[?1049l");
        expect(process.stdout.listenerCount("resize")).toBe(listeners);
      } finally {
        kill.mockRestore();
        write.mockRestore();
        resume.mockRestore();
        pause.mockRestore();
        properties.forEach(([object, key], index) => {
          const descriptor = descriptors[index];
          if (descriptor) Object.defineProperty(object, key, descriptor);
          else Reflect.deleteProperty(object, key);
        });
      }
    },
  );
});
