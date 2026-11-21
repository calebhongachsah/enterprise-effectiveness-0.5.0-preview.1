import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_CONFIG,
  normalizeRows,
  parseCsv,
} from "../packages/core/v01.js";

const csv = await readFile(
  new URL("../data/v02-simulated-pilot-1800-utf8.csv", import.meta.url),
  "utf8",
);
const parsed = parseCsv(csv.replace(/^\uFEFF/, ""));
const normalized = normalizeRows(
  parsed.rows,
  DEFAULT_CONFIG,
  "2026-10-07T12:00:00+08:00",
);

function durationHours(
  row: Record<string, string>,
  start: string,
  end: string,
) {
  if (!row[start] || !row[end]) return null;
  return (Date.parse(row[end]) - Date.parse(row[start])) / 3_600_000;
}

function average(values: Array<number | null>) {
  const usable = values.filter((value): value is number => value !== null);
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

test("V0.2 模拟试点数据覆盖12个月、1800个唯一事项和6个团队", () => {
  assert.equal(parsed.rows.length, 1_800);
  assert.equal(new Set(parsed.rows.map((row) => row.ticket_id)).size, 1_800);
  assert.deepEqual([...new Set(parsed.rows.map((row) => row.team))].sort(), [
    "交易平台",
    "内部工具",
    "商家产品",
    "基础架构",
    "数据平台",
    "用户增长",
  ]);
  const months = new Set(
    parsed.rows.map((row) => row.requirements_started_at.slice(0, 7)),
  );
  assert.equal(months.size, 12);
  assert.equal([...months].sort()[0], "2025-10");
  assert.equal([...months].sort().at(-1), "2026-09");
});

test("V0.2 模拟试点数据全部满足字段、时间顺序和来源质量规则", () => {
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(normalized.issues, []);
  assert.equal(normalized.validRows.length, 1_800);
  assert.ok(normalized.measurements.length > 15_000);
});

test("模拟故事包含交易平台改善、测试环境波动和第10月新增团队", () => {
  const trade = parsed.rows.filter((row) => row.team === "交易平台");
  const earlyWait = average(
    trade
      .filter((row) => row.requirements_started_at < "2025-12")
      .map((row) =>
        durationHours(
          row,
          "wait_development_started_at",
          "wait_development_ended_at",
        ),
      ),
  );
  const improvedWait = average(
    trade
      .filter(
        (row) =>
          row.requirements_started_at >= "2025-12" &&
          row.requirements_started_at < "2026-02",
      )
      .map((row) =>
        durationHours(
          row,
          "wait_development_started_at",
          "wait_development_ended_at",
        ),
      ),
  );
  const unstableTesting = average(
    parsed.rows
      .filter(
        (row) =>
          row.requirements_started_at >= "2026-05" &&
          row.requirements_started_at < "2026-07",
      )
      .map((row) =>
        durationHours(row, "testing_started_at", "testing_ended_at"),
      ),
  );
  const normalTesting = average(
    parsed.rows
      .filter(
        (row) =>
          row.requirements_started_at >= "2026-03" &&
          row.requirements_started_at < "2026-05",
      )
      .map((row) =>
        durationHours(row, "testing_started_at", "testing_ended_at"),
      ),
  );
  assert.ok(earlyWait > improvedWait * 2);
  assert.ok(unstableTesting > normalTesting * 1.7);
  assert.ok(
    parsed.rows
      .filter((row) => row.team === "内部工具")
      .every((row) => row.requirements_started_at >= "2026-07"),
  );
});
