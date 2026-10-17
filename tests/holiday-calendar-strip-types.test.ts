// scripts/seed-employees.ts loads src/domain/holiday-calendar.ts directly with `node --experimental-strip-types`,
// which cannot resolve extensionless relative imports. This runs the module that way (no bundler, no aliases)
// and builds the provisional calendar, so a runtime import added to the module is caught here.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const moduleUrl = pathToFileURL(join(root, "src", "domain", "holiday-calendar.ts")).href;
const csvPath = join(root, "docs", "holiday-calendars", "bangladesh-2026.csv");
const program = `
import { readFileSync } from "node:fs";
const { buildCalendar } = await import(${JSON.stringify(moduleUrl)});
const calendar = buildCalendar([{ name: "bangladesh-2026.csv", text: readFileSync(${JSON.stringify(csvPath)}, "utf8") }]);
console.log(JSON.stringify({ start: calendar.supportedYearStart, end: calendar.supportedYearEnd, count: calendar.holidays.length }));
`;

describe("holiday-calendar under plain node --experimental-strip-types", () => {
  it("loads and builds the provisional calendar (2026–2026, 31 holidays)", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", program], {
      cwd: root, encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" } as NodeJS.ProcessEnv,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ start: 2026, end: 2026, count: 31 });
  });
});
