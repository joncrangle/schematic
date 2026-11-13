import { afterEach, expect, it, vi } from "vitest";
import * as prompts from "../../scripts/lib/mini-tui";
import * as seedCore from "../../scripts/lib/gtfs-seeder-core";
import { runSeedCli } from "../../scripts/seed";

vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});

const originalExitCode = process.exitCode;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(() => {
  process.exitCode = originalExitCode;
  if (originalIsTTY) Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  vi.restoreAllMocks();
});

it("exits before database selection or seeding when the wizard selects no agencies", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["bun", "scripts/seed.ts"]);
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(prompts, "promptMultiSelect").mockResolvedValue([]);
  const databasePrompt = vi
    .spyOn(prompts, "promptSingleSelect")
    .mockRejectedValue(new Error("Unexpected database prompt"));
  const fetchArchives = vi
    .spyOn(seedCore, "fetchAllAgencyArchives")
    .mockRejectedValue(new Error("Unexpected feed request"));

  await runSeedCli();

  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("No agencies selected"));
  expect(databasePrompt).not.toHaveBeenCalled();
  expect(fetchArchives).not.toHaveBeenCalled();
});
