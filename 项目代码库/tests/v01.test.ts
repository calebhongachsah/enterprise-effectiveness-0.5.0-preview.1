import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_CONFIG,
  compareProcessStructure,
  normalizeRows,
  parseCsv,
  percentile,
  summarizeDashboard,
  summarizeStages,
  validateConfig,
  resolveSlaHours,
  simulateMeasurementsWithCurrentSla,
} from "../packages/core/v01.js";

const csv = await readFile(
  new URL("../data/software-development-demo-utf8.csv", import.meta.url),
  "utf8",
);
const parsed = parseCsv(csv);
const normalized = normalizeRows(
  parsed.rows,
  DEFAULT_CONFIG,
  "2026-09-30T12:00:00+08:00",
);

test("Demo CSV 有 48 条唯一单据、4 个团队且配置字段完整", () => {
  assert.equal(parsed.rows.length, 48);
  assert.deepEqual(validateConfig(DEFAULT_CONFIG, parsed.headers), []);
  assert.equal(new Set(parsed.rows.map((row) => row.ticket_id)).size, 48);
  assert.deepEqual([...new Set(parsed.rows.map((row) => row.team))].sort(), [
    "Team A",
    "Team B",
    "Team C",
    "Team D",
  ]);
});

test("Demo CSV 全部通过来源字段质量校验", () => {
  assert.equal(normalized.issues.length, 0);
  assert.equal(normalized.validRows.length, 48);
});

test("P50/P90 采用 nearest-rank", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});

test("等待开发和测试被识别为异常环节", () => {
  const stages = summarizeStages(normalized.measurements, DEFAULT_CONFIG);
  assert.equal(
    stages.find((stage) => stage.id === "wait_development")?.abnormal,
    true,
  );
  assert.equal(stages.find((stage) => stage.id === "testing")?.abnormal, true);
});

test("环节 SLA 达成率只按已完成记录计算", () => {
  const stages = summarizeStages(normalized.measurements, DEFAULT_CONFIG);
  const stage = stages.find((item) => item.id === "wait_development");
  const completed = normalized.measurements.filter(
    (item) => item.stageId === "wait_development" && item.state === "completed",
  );
  const achieved = completed.filter((item) => !item.overdue);

  assert.ok(stage);
  assert.equal(stage.slaAchievementRate, achieved.length / completed.length);
  assert.equal(
    stage.completedOverdueCount,
    completed.filter((item) => item.overdue).length,
  );
});

test("发布成功率与数据有效率正确", () => {
  const summary = summarizeDashboard(
    normalized.validRows,
    normalized.measurements,
    DEFAULT_CONFIG,
    parsed.rows.length,
  );
  assert.equal(summary.releaseSuccessRate, 36 / 40);
  assert.equal(summary.dataValidRate, 1);
  assert.equal(summary.completedTicketCount, 40);
});

test("平台拒绝跨环节倒序，不修改来源事实", () => {
  const bad = structuredClone(parsed.rows[0]);
  bad.design_started_at = "2026-07-31T00:00:00+00:00";
  const result = normalizeRows(
    [bad],
    DEFAULT_CONFIG,
    "2026-09-30T12:00:00+08:00",
  );
  assert.equal(result.validRows.length, 0);
  assert.ok(result.issues.some((issue) => issue.code === "stage_overlap"));
});

test("团队 SLA 覆盖默认值，其他团队继续继承流程默认值", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.teamSlaHours = {
    "Team A": { wait_development: { P1: 6 } },
  };
  const teamA = parsed.rows.find(
    (row) => row.team === "Team A" && row.priority === "P1",
  )!;
  const teamB = parsed.rows.find(
    (row) => row.team === "Team B" && row.priority === "P1",
  )!;
  const result = normalizeRows(
    [teamA, teamB],
    config,
    "2026-09-30T12:00:00+08:00",
  );
  const stage = config.stages.find((item) => item.id === "wait_development")!;
  assert.equal(resolveSlaHours(config, stage, "P1", "Team A"), 6);
  assert.equal(resolveSlaHours(config, stage, "P1", "Team B"), 12);
  assert.equal(
    result.measurements.find(
      (item) => item.ticketId === teamA.ticket_id && item.stageId === stage.id,
    )?.slaHours,
    6,
  );
});

test("团队 SLA 拒绝未知环节和非正数", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.teamSlaHours = {
    "Team A": {
      wait_development: { P1: 0 },
      unknown_stage: { P1: 8 },
    },
  };
  const errors = validateConfig(config, parsed.headers);
  assert.ok(errors.some((error) => error.includes("必须大于 0")));
  assert.ok(errors.some((error) => error.includes("未知环节")));
});

test("流程结构只比较环节身份、名称、顺序和类型", () => {
  const slaOnly = structuredClone(DEFAULT_CONFIG);
  slaOnly.stages[0].slaHours.P1 = 999;
  slaOnly.stages[0].startField = "another_start";
  assert.equal(compareProcessStructure(DEFAULT_CONFIG, slaOnly).changed, false);

  const renamed = structuredClone(DEFAULT_CONFIG);
  renamed.stages[0].name = "需求澄清";
  assert.deepEqual(compareProcessStructure(DEFAULT_CONFIG, renamed).changes, [
    {
      kind: "renamed",
      stageId: "requirements",
      before: "需求定义",
      after: "需求澄清",
    },
  ]);
});

test("按当前配置模拟只重算 SLA 与超期，不修改历史观测", () => {
  const historical = normalized.measurements.find(
    (item) =>
      item.stageId === "wait_development" &&
      parsed.rows.find(
        (row) => row.ticket_id === item.ticketId && row.team === "Team A",
      ),
  )!;
  const historicalSla = historical.slaHours;
  const config = structuredClone(DEFAULT_CONFIG);
  config.teamSlaHours = {
    "Team A": { wait_development: { [historical.priority]: 0.5 } },
  };
  const simulated = simulateMeasurementsWithCurrentSla([historical], config, {
    [historical.ticketId]: "Team A",
  })[0];
  assert.equal(simulated.slaHours, 0.5);
  assert.equal(simulated.overdue, (historical.hours ?? 0) > 0.5);
  assert.notEqual(simulated, historical);
  assert.equal(historical.slaHours, historicalSla);
});
