/**
 * Core product invariant: the three-step severity ladder every agency
 * maps its alerts onto. Agencies classify; Core owns ranking and colors.
 */
export type Severity = "normal" | "degraded" | "severe";

export const SeverityLadder = [
  "normal",
  "degraded",
  "severe",
] as const satisfies readonly Severity[];

export const SEVERITY_RANK: Record<Severity, number> = {
  normal: 0,
  degraded: 1,
  severe: 2,
};

/** Canonical status colors pinned by the GLOSSARY.md visual semantics. */
export const SEVERITY_COLORS: Record<Severity, string> = {
  normal: "#22c55e",
  degraded: "#f59e0b",
  severe: "#ef4444",
};
