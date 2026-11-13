import * as readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

/**
 * Mini-TUI primitives for interactive command-line wizards.
 *
 * Renders a fixed-height viewport so long option lists never outgrow the
 * terminal, supports incremental filtering, collapsible groups, and a clean
 * cross-platform raw-mode terminal lifecycle.
 *
 * Multi-select keys:
 *   ↑/↓ or j/k   move
 *   Space        toggle the row (a group header toggles its members)
 *   a            toggle every visible row
 *   i            invert every visible row
 *   /            edit the filter (type to narrow the list)
 *   ←/→ or [ ]   collapse/expand the group under the cursor
 *   Enter        accept
 *   Esc/q        clear an active filter, otherwise cancel
 */

export interface SelectOption<T = string> {
  readonly id: T;
  readonly label: string;
  readonly checked?: boolean;
  /** Section labels can also toggle every selectable option in `group`. */
  readonly isHeader?: boolean;
  readonly group?: string;
  /** Extra nesting levels rendered as leading whitespace (region members). */
  readonly indent?: number;
}

export interface PromptViewport {
  readonly rows: number;
  readonly columns: number;
}

/** Thrown when the operator aborts a prompt; callers decide how to exit. */
export class PromptCancelledError extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

const ENTER_SCREEN = "\x1B[?1049h";
const LEAVE_SCREEN = "\x1B[?1049l";
const CLEAR_SCREEN = "\x1B[H\x1B[2J";
const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";
const CYAN = (text: string) => `\x1B[36m${text}\x1B[0m`;
const GREEN = (text: string) => `\x1B[32m${text}\x1B[0m`;
const YELLOW = (text: string) => `\x1B[33m${text}\x1B[0m`;
const BOLD = (text: string) => `\x1B[1m${text}\x1B[0m`;
const DIM = (text: string) => `\x1B[2m${text}\x1B[0m`;

const graphemes = new Intl.Segmenter();

const FILTER_FOOTER = "Type to filter · Tab toggle · Enter apply · Esc revert · ↑↓ move";
const SINGLE_SELECT_FOOTER = "↑↓ move · Enter accept · Esc cancel";
const MULTI_SELECT_FOOTER =
  "Enter accept · Esc cancel · Tab/Space toggle · a all shown · i invert · / filter · ←→/[ ] group";
const MULTI_SELECT_FOOTER_NARROW = [
  "↑↓ move · Tab/Space toggle · a all shown · i invert · / filter",
  "←→ or [ ] group · Enter accept · Esc cancel",
];

function multiSelectFooterLines(filterEditing: boolean, columns: number): readonly string[] {
  if (filterEditing) return [FILTER_FOOTER];
  if (columns < MULTI_SELECT_FOOTER.length + 2) return MULTI_SELECT_FOOTER_NARROW;
  return [MULTI_SELECT_FOOTER];
}

// eslint-disable-next-line no-control-regex -- ANSI escape sequences start with the ESC control character.
const ANSI_SEQUENCE = /\x1B\[[0-9;?]*[ -/]*[@-~]/y;

/** Clips a styled line to the terminal width without splitting escape codes. */
export function clipLine(line: string, columns: number): string {
  if (columns <= 0) return "";
  if (stringWidth(line) <= columns) return line;
  let output = "";
  let visible = 0;
  let index = 0;
  while (index < line.length) {
    ANSI_SEQUENCE.lastIndex = index;
    const match = ANSI_SEQUENCE.exec(line);
    if (match) {
      output += match[0];
      index = ANSI_SEQUENCE.lastIndex;
      continue;
    }
    const segment = graphemes.segment(line.slice(index))[Symbol.iterator]().next().value?.segment;
    if (!segment) break;
    const width = stringWidth(segment);
    if (visible + width > columns - 1) break;
    output += segment;
    visible += width;
    index += segment.length;
  }
  return `${output}…\x1B[0m`;
}

export interface WindowSlice {
  readonly start: number;
  readonly end: number;
  readonly moreAbove: number;
  readonly moreBelow: number;
}

/**
 * Chooses the visible slice of `total` rows around `cursor`, keeping scroll
 * indicators inside the same row budget so the frame always fits.
 */
export function resolveWindow(cursor: number, total: number, maxRows: number): WindowSlice {
  const limit = Math.max(1, maxRows);
  if (limit < 3) {
    const start = Math.max(0, Math.min(cursor, total - 1));
    return { start, end: Math.min(total, start + 1), moreAbove: 0, moreBelow: 0 };
  }
  let size = Math.min(total, limit);
  for (;;) {
    const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), Math.max(0, total - size)));
    const end = Math.min(total, start + size);
    const moreAbove = start;
    const moreBelow = total - end;
    const overhead = (moreAbove > 0 ? 1 : 0) + (moreBelow > 0 ? 1 : 0);
    if (size + overhead <= limit || size <= 1) return { start, end, moreAbove, moreBelow };
    size -= 1;
  }
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1));
}

function rotateIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

function optionId(option: SelectOption): string {
  return String(option.id);
}

function isSelectableOption(option: SelectOption): boolean {
  return !option.isHeader && option.id !== "all";
}

function truncatePlain(text: string, maxLength: number): string {
  return stripVTControlCharacters(clipLine(text, maxLength));
}

export interface MultiSelectState {
  readonly cursor: number;
  readonly selected: ReadonlySet<string>;
  readonly filter: string;
  readonly filterEditing: boolean;
  readonly collapsed: ReadonlySet<string>;
}

export type MultiSelectAction =
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "toggle" }
  | { readonly type: "toggle-all" }
  | { readonly type: "invert" }
  | { readonly type: "collapse" }
  | { readonly type: "expand" }
  | { readonly type: "submit" }
  | { readonly type: "cancel" }
  | { readonly type: "open-filter" }
  | { readonly type: "close-filter" }
  | { readonly type: "revert-filter" }
  | { readonly type: "filter-text"; readonly text: string }
  | { readonly type: "filter-backspace" };

export type MultiSelectOutcome<T extends string> =
  | { readonly kind: "state"; readonly state: MultiSelectState }
  | { readonly kind: "submit"; readonly ids: readonly T[] }
  | { readonly kind: "cancel" };

/** Translates a raw keypress into the action the reducer understands. */
export function multiSelectActionForKey(
  text: string | undefined,
  key: readline.Key,
  filterEditing: boolean,
): MultiSelectAction | null {
  const char = text && text.length === 1 ? text : undefined;
  const lower = char?.toLowerCase();

  if (filterEditing) {
    if (key.name === "escape") return { type: "revert-filter" };
    if (key.name === "return" || key.name === "enter") return { type: "close-filter" };
    if (key.name === "up") return { type: "move", delta: -1 };
    if (key.name === "down") return { type: "move", delta: 1 };
    if (key.name === "tab") return { type: "toggle" };
    if (key.name === "backspace") return { type: "filter-backspace" };
    if (char && !key.ctrl && !key.meta && char >= " ") return { type: "filter-text", text: char };
    return null;
  }

  if (key.name === "up" || lower === "k") return { type: "move", delta: -1 };
  if (key.name === "down" || lower === "j") return { type: "move", delta: 1 };
  if (key.name === "return" || key.name === "enter") return { type: "submit" };
  if (key.name === "escape") return { type: "cancel" };
  if (key.name === "left" || char === "[") return { type: "collapse" };
  if (key.name === "right" || char === "]") return { type: "expand" };
  if (key.name === "tab" || key.name === "space") return { type: "toggle" };
  if (lower === "a") return { type: "toggle-all" };
  if (lower === "i") return { type: "invert" };
  if (char === "/") return { type: "open-filter" };
  if (lower === "q") return { type: "cancel" };
  return null;
}

interface OptionBlock<T> {
  readonly header?: SelectOption<T>;
  readonly members: readonly SelectOption<T>[];
}

function optionBlocks<T extends string>(options: readonly SelectOption<T>[]): OptionBlock<T>[] {
  const blocks: OptionBlock<T>[] = [];
  let current: { header?: SelectOption<T>; members: SelectOption<T>[] } | undefined;
  for (const option of options) {
    if (option.id === "all") continue;
    if (option.isHeader) {
      current = { header: option, members: [] };
      blocks.push(current);
      continue;
    }
    if (current && (option.group === undefined || option.group === current.header?.group)) {
      current.members.push(option);
      continue;
    }
    current = { members: [option] };
    blocks.push(current);
  }
  return blocks;
}

function matchesFilter(option: SelectOption, query: string): boolean {
  if (!query) return true;
  return [option.label, optionId(option), option.group ?? ""].some((value) =>
    value.toLowerCase().includes(query),
  );
}

/**
 * Flattens `options` into the rows the operator can currently see: the
 * select-all row, group headers, and members that survive the filter and the
 * collapsed set. A filter matches every member regardless of collapse.
 */
export function visibleMultiSelectRows<T extends string>(
  options: readonly SelectOption<T>[],
  state: Pick<MultiSelectState, "filter" | "collapsed">,
): readonly SelectOption<T>[] {
  const query = state.filter.trim().toLowerCase();
  const blocks = optionBlocks(options)
    .map((block) => ({
      header: block.header,
      members: block.members.filter((member) => matchesFilter(member, query)),
    }))
    .filter((block) => !query || block.members.length > 0);
  const hasMatches = blocks.some((block) => block.members.length > 0);
  const rows: SelectOption<T>[] = [];
  const all = options.find((option) => option.id === "all");
  if (all && (!query || hasMatches)) rows.push(all);
  for (const block of blocks) {
    if (block.header) rows.push(block.header);
    const collapsed = block.header?.group ? state.collapsed.has(block.header.group) : false;
    if (collapsed && !query) continue;
    rows.push(...block.members);
  }
  return rows;
}

function toggleSelection(selected: Set<string>, options: readonly SelectOption[]): void {
  const allSelected =
    options.length > 0 && options.every((option) => selected.has(optionId(option)));
  for (const option of options) {
    if (allSelected) selected.delete(optionId(option));
    else selected.add(optionId(option));
  }
}

function clampCursor<T extends string>(
  options: readonly SelectOption<T>[],
  state: MultiSelectState,
): MultiSelectState {
  const rows = visibleMultiSelectRows(options, state);
  const cursor = rows.length === 0 ? 0 : Math.min(state.cursor, rows.length - 1);
  return cursor === state.cursor ? state : { ...state, cursor };
}

/**
 * The select-all row and group headers are not agencies, so a fresh filter
 * lands the cursor on the first real match; otherwise Space/Tab would toggle
 * the whole matching set instead of the agency the operator can see.
 */
function firstSelectableIndex<T extends string>(
  rows: readonly SelectOption<T>[],
): number | undefined {
  const index = rows.findIndex(isSelectableOption);
  return index >= 0 ? index : undefined;
}

/** Applies one interaction to the picker. Pure, so the key map stays testable. */
export function reduceMultiSelect<T extends string>(
  options: readonly SelectOption<T>[],
  state: MultiSelectState,
  action: MultiSelectAction,
): MultiSelectOutcome<T> {
  const rows = visibleMultiSelectRows(options, state);
  const visibleSelectable = rows.filter(isSelectableOption);
  const allSelectable = options.filter(isSelectableOption);
  const next = (patch: Partial<MultiSelectState>): MultiSelectOutcome<T> => ({
    kind: "state",
    state: clampCursor(options, { ...state, ...patch }),
  });

  switch (action.type) {
    case "move":
      if (rows.length === 0) return { kind: "state", state };
      return next({ cursor: rotateIndex(state.cursor, action.delta, rows.length) });

    case "toggle": {
      const current = rows[state.cursor];
      if (!current) return { kind: "state", state };
      const query = state.filter.trim().toLowerCase();
      const selected = new Set(state.selected);
      if (current.isHeader && current.group) {
        toggleSelection(
          selected,
          allSelectable.filter(
            (option) => option.group === current.group && matchesFilter(option, query),
          ),
        );
      } else if (optionId(current) === "all") {
        toggleSelection(selected, visibleSelectable);
      } else {
        const id = optionId(current);
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
      return next({ selected });
    }

    case "toggle-all": {
      const selected = new Set(state.selected);
      toggleSelection(selected, visibleSelectable);
      return next({ selected });
    }

    case "invert": {
      const selected = new Set(state.selected);
      for (const option of visibleSelectable) {
        const id = optionId(option);
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
      return next({ selected });
    }

    case "collapse":
    case "expand": {
      const group = rows[state.cursor]?.group;
      if (!group) return { kind: "state", state };
      const collapsed = new Set(state.collapsed);
      if (action.type === "collapse") collapsed.add(group);
      else collapsed.delete(group);
      const updated = { ...state, collapsed };
      const updatedRows = visibleMultiSelectRows(options, updated);
      const currentId = rows[state.cursor]?.id;
      const cursor = updatedRows.findIndex((row) => row.id === currentId);
      const header = updatedRows.findIndex((row) => row.isHeader && row.group === group);
      return next({ collapsed, cursor: cursor >= 0 ? cursor : Math.max(0, header) });
    }

    case "open-filter":
      return next({ filterEditing: true, cursor: firstSelectableIndex(rows) ?? 0 });

    case "close-filter":
      return next({ filterEditing: false });

    case "revert-filter":
      return next({ filter: "", filterEditing: false, cursor: 0 });

    case "filter-text": {
      const filter = state.filter + action.text;
      const matched = visibleMultiSelectRows(options, { ...state, filter });
      return next({ filter, filterEditing: true, cursor: firstSelectableIndex(matched) ?? 0 });
    }

    case "filter-backspace": {
      const filter = state.filter.slice(0, -1);
      const matched = visibleMultiSelectRows(options, { ...state, filter });
      return next({ filter, cursor: firstSelectableIndex(matched) ?? 0 });
    }

    case "submit": {
      // A filter narrows the run to what the operator can see. Selections
      // outside it stay checked but are ignored until the filter is cleared.
      const query = state.filter.trim().toLowerCase();
      const scope = query ? visibleSelectable : allSelectable;
      return {
        kind: "submit",
        ids: scope
          .filter((option) => state.selected.has(optionId(option)))
          .map((option) => option.id),
      };
    }

    case "cancel":
      if (state.filter || state.filterEditing) {
        return next({ filter: "", filterEditing: false, cursor: 0 });
      }
      return { kind: "cancel" };
  }
}

/** Renders the multi-select frame. Pure so tests can pin layout and filtering. */
export function buildMultiSelectLines<T extends string>(
  title: string,
  options: readonly SelectOption<T>[],
  state: MultiSelectState,
  viewport: PromptViewport,
): readonly string[] {
  const columns = Math.max(1, viewport.columns);
  const rows = visibleMultiSelectRows(options, state);
  const selectable = options.filter(isSelectableOption);
  const query = state.filter.trim();
  const normalizedQuery = query.toLowerCase();
  const visibleSelectable = rows.filter(isSelectableOption);
  const selectedCount = selectable.filter((option) => state.selected.has(optionId(option))).length;
  const matchingSelected = visibleSelectable.filter((option) =>
    state.selected.has(optionId(option)),
  ).length;
  const status = query
    ? `${DIM(`${matchingSelected}/${visibleSelectable.length} matching · ${selectedCount}/${selectable.length} total · filter:`)} ${CYAN(`"${state.filter}"`)}`
    : DIM(`${selectedCount} of ${selectable.length} selected`);

  const height = Math.max(1, viewport.rows);
  const lines = [
    clipLine(`${BOLD(CYAN("?"))} ${BOLD(title)}`, columns),
    clipLine(`  ${status}`, columns),
  ].slice(0, Math.max(0, height - 1));

  const renderRow = (option: SelectOption<T>, isCursor: boolean): string => {
    const isAll = optionId(option) === "all";
    // Toggling acts on what the operator can see, so counts must too. A
    // filtered group only carries its matching members; an unfiltered one
    // carries every member so a collapsed header still toggles the region.
    const members = option.group
      ? selectable.filter(
          (row) => row.group === option.group && (!query || matchesFilter(row, normalizedQuery)),
        )
      : [];
    const scope = isAll ? visibleSelectable : members;
    const checked = isAll
      ? scope.length > 0 && scope.every((row) => state.selected.has(optionId(row)))
      : option.isHeader && option.group
        ? members.length > 0 && members.every((row) => state.selected.has(optionId(row)))
        : state.selected.has(optionId(option));
    const collapsed =
      !query && option.isHeader && option.group ? state.collapsed.has(option.group) : false;
    const marker = option.isHeader
      ? option.group
        ? collapsed
          ? "▸ "
          : "▾ "
        : "  "
      : isAll
        ? "  "
        : "";
    const indent = "  ".repeat(Math.max(0, option.indent ?? 0));
    const prefix = isCursor ? CYAN("❯") : " ";
    const box = option.isHeader && !option.group ? "   " : checked ? GREEN("[✔]") : "[ ]";
    const counts =
      isAll || (option.isHeader && option.group)
        ? ` ${DIM(`(${scope.filter((row) => state.selected.has(optionId(row))).length}/${scope.length})`)}`
        : "";
    const overhead = 8 + indent.length + marker.length + stripVTControlCharacters(counts).length;
    // The select-all row describes its real scope: a filter or a collapsed
    // region means it can no longer speak for every configured agency.
    const rowLabel = isAll
      ? query
        ? "All matching agencies"
        : state.collapsed.size > 0
          ? "All visible agencies"
          : option.label
      : option.label;
    const label = option.isHeader
      ? BOLD(truncatePlain(rowLabel, Math.max(1, columns - overhead)))
      : isCursor
        ? BOLD(truncatePlain(rowLabel, Math.max(1, columns - overhead)))
        : truncatePlain(rowLabel, Math.max(1, columns - overhead));
    return `${"  "}${prefix} ${box} ${indent}${marker}${label}${counts}`;
  };

  const footer = multiSelectFooterLines(state.filterEditing, columns).slice(
    0,
    Math.max(0, height - lines.length - 1),
  );
  const maxRows = Math.max(1, height - lines.length - footer.length);
  if (rows.length === 0) {
    lines.push(clipLine(`  ${YELLOW(`No options match "${state.filter}"`)}`, columns));
  } else {
    const slice = resolveWindow(state.cursor, rows.length, maxRows);
    if (slice.moreAbove > 0) {
      lines.push(clipLine(`  ${DIM(`↑ ${slice.moreAbove} more above`)}`, columns));
    }
    for (let index = slice.start; index < slice.end; index += 1) {
      lines.push(clipLine(renderRow(rows[index], index === state.cursor), columns));
    }
    if (slice.moreBelow > 0) {
      lines.push(clipLine(`  ${DIM(`↓ ${slice.moreBelow} more below`)}`, columns));
    }
  }

  for (const line of footer) lines.push(clipLine(`  ${DIM(line)}`, columns));
  return lines;
}

/** Renders the single-select frame. */
export function buildSingleSelectLines<T extends string>(
  title: string,
  options: readonly SelectOption<T>[],
  cursor: number,
  viewport: PromptViewport,
): readonly string[] {
  const columns = Math.max(1, viewport.columns);
  const height = Math.max(1, viewport.rows);
  const header = height > 1;
  const footer = height > 2;
  const maxRows = Math.max(1, height - Number(header) - Number(footer));
  const slice = resolveWindow(cursor, options.length, maxRows);
  const lines: string[] = header ? [clipLine(`${BOLD(CYAN("?"))} ${BOLD(title)}`, columns)] : [];
  if (slice.moreAbove > 0) {
    lines.push(clipLine(`  ${DIM(`↑ ${slice.moreAbove} more above`)}`, columns));
  }
  for (let index = slice.start; index < slice.end; index += 1) {
    const option = options[index];
    const isSelected = index === cursor;
    const prefix = isSelected ? CYAN("❯") : " ";
    const box = isSelected ? GREEN("[✔]") : "[ ]";
    const indent = "  ".repeat(Math.max(0, option.indent ?? 0));
    const overhead = 8 + indent.length;
    const label = isSelected
      ? BOLD(truncatePlain(option.label, Math.max(1, columns - overhead)))
      : truncatePlain(option.label, Math.max(1, columns - overhead));
    lines.push(clipLine(`  ${prefix} ${box} ${indent}${label}`, columns));
  }
  if (slice.moreBelow > 0) {
    lines.push(clipLine(`  ${DIM(`↓ ${slice.moreBelow} more below`)}`, columns));
  }
  if (footer) lines.push(clipLine(`  ${DIM(SINGLE_SELECT_FOOTER)}`, columns));
  return lines;
}

/**
 * Summarizes an accepted selection so a long agency list collapses into counts
 * instead of one unreadable comma-joined line.
 */
export function formatSelectionSummary<T extends string>(
  title: string,
  options: readonly SelectOption<T>[],
  selectedIds: readonly string[],
  noun = "option",
  plural = `${noun}s`,
): readonly string[] {
  const selected = new Set(selectedIds.map(String));
  const selectable = options.filter(isSelectableOption);
  const chosen = selectable.filter((option) => selected.has(optionId(option)));
  const heading =
    chosen.length === 0
      ? "none"
      : chosen.length === selectable.length
        ? `all ${chosen.length} ${plural}`
        : `${chosen.length} of ${selectable.length} ${plural}`;
  const lines: string[] = [`${GREEN("✔")} ${BOLD(title)} → ${CYAN(heading)}`];

  const groups = new Map<string, { label: string; total: number; selected: number }>();
  for (const option of selectable) {
    const key = option.group ?? "";
    const entry = groups.get(key) ?? {
      label:
        options.find((candidate) => candidate.isHeader && candidate.group === option.group)
          ?.label ?? "",
      total: 0,
      selected: 0,
    };
    entry.total += 1;
    if (selected.has(optionId(option))) entry.selected += 1;
    groups.set(key, entry);
  }
  if (groups.size > 1) {
    lines.push(
      `  ${[...groups.values()]
        .map((group) => `${DIM(group.label)} ${group.selected}/${group.total}`)
        .join("   ")}`,
    );
  }
  if (chosen.length > 0 && chosen.length <= 8) {
    lines.push(`  ${DIM(chosen.map((option) => optionId(option)).join(", "))}`);
  }
  return lines;
}

interface RunnerContext<T> {
  readonly refresh: () => void;
  readonly finish: (value: T) => void;
  readonly cancel: () => void;
}

function createPromptRunner<T>(
  render: () => readonly string[],
  onKey: (ctx: RunnerContext<T>, text: string | undefined, key: readline.Key) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const wasRaw = process.stdin.isRaw ?? false;

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onSignal = (signal: NodeJS.Signals) => {
      cleanup();
      // Flush terminal restoration before re-raising with the default handler.
      process.stdout.write("", () => process.kill(process.pid, signal));
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      process.stdout.write(`${SHOW_CURSOR}${LEAVE_SCREEN}`);
      process.stdout.off("resize", onResize);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
      process.off("exit", cleanup);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      process.off("SIGINT", onSignal);
    };

    // The alternate screen isolates redraws and terminal reflow from prior logs.
    // Every frame starts at home; shrinking either dimension cannot move the
    // erase into scrollback or leave part of a reflowed frame behind.
    const refresh = () => {
      if (done) return;
      const columns = Math.max(1, process.stdout.columns || 80);
      const frame = render().map((line) => clipLine(line, columns));
      process.stdout.write(`${CLEAR_SCREEN}${frame.join("\r\n")}`);
    };

    const finish = (value: T) => {
      cleanup();
      resolve(value);
    };

    const cancel = () => {
      cleanup();
      reject(new PromptCancelledError());
    };

    const onResize = () => refresh();

    const onKeypress = (text: string | undefined, key: readline.Key | undefined) => {
      if (!key || done) return;
      onKey({ refresh, finish, cancel }, text, key);
      if (!done) refresh();
    };

    process.stdout.write(`${ENTER_SCREEN}${HIDE_CURSOR}`);
    process.stdin.on("keypress", onKeypress);
    process.stdout.on("resize", onResize);
    process.once("exit", cleanup);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);
    process.once("SIGINT", onSignal);
    refresh();
  });
}

function currentViewport(): PromptViewport {
  return {
    rows: Math.max(1, process.stdout.rows || 24),
    columns: Math.max(1, process.stdout.columns || 80),
  };
}

/**
 * Prompts user with a multi-select checkbox list.
 * Keys: ↑/↓/j/k (move), Space (toggle), a (toggle visible), i (invert visible),
 * / (filter), ←/→ or [/] (collapse/expand group), Enter (confirm),
 * Esc/q/Ctrl+C (clear filter, then cancel).
 */
export async function promptMultiSelect<T extends string = string>(
  title: string,
  options: readonly SelectOption<T>[],
): Promise<T[]> {
  if (options.length === 0) return [];
  const selectable = options.filter(isSelectableOption);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return selectable.filter((option) => option.checked).map((option) => option.id);
  }

  let state: MultiSelectState = {
    cursor: 0,
    selected: new Set(selectable.filter((option) => option.checked).map(optionId)),
    filter: "",
    filterEditing: false,
    collapsed: new Set<string>(),
  };

  const result = await createPromptRunner<T[]>(
    () => buildMultiSelectLines(title, options, state, currentViewport()),
    (ctx, text, key) => {
      // Ctrl+C aborts outright; Esc is the key that clears an active filter.
      if (key.ctrl && key.name === "c") {
        ctx.cancel();
        return;
      }
      const action = multiSelectActionForKey(text, key, state.filterEditing);
      if (!action) return;
      const outcome = reduceMultiSelect(options, state, action);
      if (outcome.kind === "cancel") {
        ctx.cancel();
        return;
      }
      if (outcome.kind === "submit") {
        ctx.finish([...outcome.ids]);
        return;
      }
      state = outcome.state;
    },
  );

  for (const line of formatSelectionSummary(title, options, result, "agency", "agencies")) {
    console.log(line);
  }
  return result;
}

/**
 * Prompts user with a single-choice radio list.
 * Keys: ↑/↓/j/k (move), Enter (confirm), Esc/q/Ctrl+C (cancel).
 */
export async function promptSingleSelect<T extends string = string>(
  title: string,
  options: readonly SelectOption<T>[],
  defaultIndex = 0,
): Promise<T> {
  if (options.length === 0) {
    throw new Error("Cannot prompt single select on an empty options array.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const fallback = options[clampIndex(defaultIndex, options.length)];
    return fallback.id;
  }

  let cursor = clampIndex(defaultIndex, options.length);

  const result = await createPromptRunner<T>(
    () => buildSingleSelectLines(title, options, cursor, currentViewport()),
    (ctx, text, key) => {
      if (key.ctrl && key.name === "c") {
        ctx.cancel();
        return;
      }
      const lower = text?.toLowerCase();
      if (key.name === "up" || lower === "k") {
        cursor = rotateIndex(cursor, -1, options.length);
        return;
      }
      if (key.name === "down" || lower === "j") {
        cursor = rotateIndex(cursor, 1, options.length);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        ctx.finish(options[cursor].id);
        return;
      }
      if (key.name === "escape" || lower === "q") ctx.cancel();
    },
  );

  const chosenLabel = options.find((option) => option.id === result)?.label ?? result;
  console.log(`${GREEN("✔")} ${BOLD(title)} → ${CYAN(chosenLabel)}`);
  return result;
}
