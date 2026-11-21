import assert from "node:assert/strict";
import test from "node:test";
import { nextScheduledAt } from "../apps/api/src/data-sources.js";

const after = new Date("2026-10-09T00:01:00.000Z");
const base = {
  enabled: true,
  hour: 2,
  minute: 0,
  dayOfWeek: 1,
  timezone: "Asia/Singapore",
} as const;

test("每 15 分钟计算下一次运行", () => {
  assert.equal(
    nextScheduledAt(
      { ...base, frequency: "EVERY_15_MINUTES" },
      after,
    ).toISOString(),
    "2026-10-09T00:15:00.000Z",
  );
});

test("每小时按指定分钟计算下一次运行", () => {
  assert.equal(
    nextScheduledAt(
      { ...base, frequency: "HOURLY", minute: 30 },
      after,
    ).toISOString(),
    "2026-10-09T00:30:00.000Z",
  );
});

test("每日计划按配置时区计算", () => {
  assert.equal(
    nextScheduledAt(
      { ...base, frequency: "DAILY", hour: 9 },
      after,
    ).toISOString(),
    "2026-10-09T01:00:00.000Z",
  );
});

test("每周计划按星期和时区计算", () => {
  assert.equal(
    nextScheduledAt(
      { ...base, frequency: "WEEKLY", dayOfWeek: 5, hour: 10 },
      after,
    ).toISOString(),
    "2026-10-09T02:00:00.000Z",
  );
});
