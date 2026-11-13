import { afterEach, expect, it, vi } from "vitest";
import * as prompts from "../../scripts/lib/mini-tui";
import * as seedCore from "../../scripts/lib/gtfs-seeder-core";
import { runSeedCli, runSeeder, type DbTarget } from "../../scripts/seed";

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

it("requires explicit agency selection for noninteractive database initialization", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["bun", "seed.js", "--database-only"]);
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  const fetchArchives = vi
    .spyOn(seedCore, "fetchAllAgencyArchives")
    .mockRejectedValue(new Error("Unexpected feed request"));
  await expect(runSeedCli()).rejects.toThrow(/--agency.*--scope/);
  expect(fetchArchives).not.toHaveBeenCalled();
});

it.each<DbTarget>(["d1", "both", "remote"])(
  "rejects %s before fetching input for database-only initialization",
  async (dbTarget) => {
    const fetchArchives = vi.fn();
    await expect(
      runSeeder({ agencies: ["sample"], dbTarget, databaseOnly: true, fetchArchives }),
    ).rejects.toThrow("requires --db=sqlite");
    expect(fetchArchives).not.toHaveBeenCalled();
  },
);

it("reports incomplete first-run initialization when only some selected agencies seed", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue([
    "bun",
    "seed.js",
    "--database-only",
    "--agency=sample,regional",
  ]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(seedCore, "fetchAllAgencyArchives").mockImplementation(async (config) => {
    if (config.id === "regional")
      throw new seedCore.FeedFetchError(config.id, config.feeds[0], "HTTP 503");
    return { buffers: config.feeds.map(() => Buffer.from("fixture")), failures: [] };
  });
  const seed = vi.spyOn(seedCore, "seedAgencySqlite").mockResolvedValue("/unused/transit.db");
  await runSeedCli();
  expect(process.exitCode).toBe(1);
  expect(seed).toHaveBeenCalledTimes(1);
  expect(seed.mock.calls[0][0].id).toBe("sample");
});
