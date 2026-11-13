# Domain guidance

Use [glossary](../../GLOSSARY.md) terms and naming conventions in code, issues,
refactor proposals, hypotheses, and tests. Check existing terms before recording
a vocabulary gap for `/domain-modeling`. If a domain document is absent,
continue without proposing scaffolding.

Read the ADRs governing the affected area before changing it.
[ADR-0007](../adr/0007-core-agency-module-app-shell-decomposition.md) owns module
boundaries; [ADR-0009](../adr/0009-two-database-storage-topology.md) owns storage.
For provider contracts or multi-agency behavior, read the
[agency guide](../add-an-agency.md).

When a proposal conflicts with an accepted ADR, name the decision and explain
why it should be reopened. For a decision/code mismatch, record both and resolve
it in the change. Research notes do not override accepted decisions; package
scripts, schemas, and the lockfile describe current commands and versions.
When updating an ADR, rewrite it to describe the current decision rather than
appending a dated amendment.
