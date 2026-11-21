import Papa from "papaparse";
import type {
  DashboardSummary,
  ImportIssue,
  ProcessConfig,
  ProcessStructureDiff,
  StageMeasurement,
  StageSummary,
} from "../contracts/v01.js";

export function compareProcessStructure(
  current: ProcessConfig,
  incoming: ProcessConfig,
): ProcessStructureDiff {
  const changes: ProcessStructureDiff["changes"] = [];
  const before = new Map(
    current.stages.map((stage, index) => [stage.id, { stage, index }]),
  );
  const after = new Map(
    incoming.stages.map((stage, index) => [stage.id, { stage, index }]),
  );
  for (const [id, value] of before) {
    const next = after.get(id);
    if (!next) {
      changes.push({ kind: "removed", stageId: id, before: value.stage.name });
      continue;
    }
    if (value.stage.name !== next.stage.name)
      changes.push({
        kind: "renamed",
        stageId: id,
        before: value.stage.name,
        after: next.stage.name,
      });
    if (value.index !== next.index)
      changes.push({
        kind: "reordered",
        stageId: id,
        before: value.index + 1,
        after: next.index + 1,
      });
    if (value.stage.type !== next.stage.type)
      changes.push({
        kind: "type_changed",
        stageId: id,
        before: value.stage.type,
        after: next.stage.type,
      });
  }
  for (const [id, value] of after)
    if (!before.has(id))
      changes.push({ kind: "added", stageId: id, after: value.stage.name });
  return { changed: changes.length > 0, changes };
}

export const DEFAULT_CONFIG: ProcessConfig = {
  name: "软件开发流程",
  timezone: "Asia/Singapore",
  keyField: "ticket_id",
  titleField: "title",
  teamField: "team",
  priorityField: "priority",
  statusField: "current_status",
  outcomeField: "release_result",
  stages: [
    stage("requirements", "需求定义", "processing", 8, 12, 24),
    stage("wait_design", "等待技术设计", "waiting", 8, 12, 24),
    stage("design", "技术设计", "processing", 12, 18, 24),
    stage("wait_development", "等待开发", "waiting", 8, 12, 16),
    stage("development", "开发", "processing", 24, 36, 48),
    stage("wait_testing", "等待测试", "waiting", 6, 12, 18),
    stage("testing", "测试", "processing", 8, 12, 16),
    stage("wait_release", "等待发布", "waiting", 6, 12, 18),
    stage("release", "发布", "processing", 4, 8, 12),
  ],
};

function stage(
  id: string,
  name: string,
  type: "processing" | "waiting",
  p0: number,
  p1: number,
  p2: number,
) {
  return {
    id,
    name,
    type,
    startField: `${id}_started_at`,
    endField: `${id}_ended_at`,
    slaHours: { P0: p0, P1: p1, P2: p2 },
  } as const;
}

export function parseCsv(csv: string) {
  const result = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.replace(/^\uFEFF/, "").trim(),
  });
  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
    errors: result.errors.map((error) => ({
      row: (error.row ?? 0) + 2,
      code: error.code,
      message: error.message,
      severity: "error" as const,
    })),
  };
}

export function validateConfig(config: ProcessConfig, headers: string[]) {
  const errors: string[] = [];
  const required = [
    config.keyField,
    config.titleField,
    config.teamField,
    config.priorityField,
    config.statusField,
  ];
  for (const field of required)
    if (!headers.includes(field)) errors.push(`未找到必填字段：${field}`);
  if (config.outcomeField && !headers.includes(config.outcomeField))
    errors.push(`未找到效果字段：${config.outcomeField}`);
  if (!config.stages.length) errors.push("至少需要一个流程环节");
  const ids = new Set<string>();
  for (const item of config.stages) {
    if (!item.id || ids.has(item.id))
      errors.push(`环节 ID 缺失或重复：${item.id}`);
    ids.add(item.id);
    if (!headers.includes(item.startField))
      errors.push(`${item.name} 缺少开始字段：${item.startField}`);
    if (!headers.includes(item.endField))
      errors.push(`${item.name} 缺少结束字段：${item.endField}`);
    for (const priority of ["P0", "P1", "P2"] as const)
      if (
        !Number.isFinite(item.slaHours[priority]) ||
        item.slaHours[priority] <= 0
      )
        errors.push(`${item.name} 的 ${priority} SLA 必须大于 0`);
  }
  for (const [team, stages] of Object.entries(config.teamSlaHours ?? {})) {
    if (!team.trim()) errors.push("团队 SLA 的团队名称不能为空");
    for (const [stageId, priorities] of Object.entries(stages)) {
      if (!ids.has(stageId))
        errors.push(`${team} 的团队 SLA 引用了未知环节：${stageId}`);
      for (const [priority, value] of Object.entries(priorities))
        if (
          !["P0", "P1", "P2"].includes(priority) ||
          !Number.isFinite(value) ||
          Number(value) <= 0
        )
          errors.push(`${team} · ${stageId} 的 ${priority} SLA 必须大于 0`);
    }
  }
  return errors;
}

export function resolveSlaHours(
  config: ProcessConfig,
  stage: ProcessConfig["stages"][number],
  priority: "P0" | "P1" | "P2",
  team?: string,
) {
  return (
    (team ? config.teamSlaHours?.[team]?.[stage.id]?.[priority] : undefined) ??
    stage.slaHours[priority] ??
    stage.slaHours.P1
  );
}

export function simulateMeasurementsWithCurrentSla(
  measurements: StageMeasurement[],
  config: ProcessConfig,
  teamByTicket: Record<string, string>,
) {
  const stages = new Map(config.stages.map((stage) => [stage.id, stage]));
  return measurements.map((measurement) => {
    const stage = stages.get(measurement.stageId);
    if (!stage) return { ...measurement };
    const slaHours = resolveSlaHours(
      config,
      stage,
      measurement.priority,
      teamByTicket[measurement.ticketId],
    );
    return {
      ...measurement,
      slaHours,
      overdue: measurement.hours === null ? null : measurement.hours > slaHours,
    };
  });
}

const parseTime = (value: string | undefined) => {
  if (!value || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

export function normalizeRows(
  rows: Record<string, string>[],
  config: ProcessConfig,
  asOf: string,
) {
  const issues: ImportIssue[] = [],
    validRows: Record<string, string>[] = [],
    measurements: StageMeasurement[] = [];
  const seen = new Set<string>(),
    asOfMs = Date.parse(asOf);
  rows.forEach((row, index) => {
    const rowNumber = index + 2,
      ticketId = row[config.keyField]?.trim();
    let invalid = false;
    if (!ticketId) {
      issues.push(
        issue(rowNumber, undefined, "missing_ticket_id", "业务主键为空"),
      );
      return;
    }
    if (seen.has(ticketId)) {
      issues.push(
        issue(
          rowNumber,
          ticketId,
          "duplicate_ticket_id",
          "同一文件内业务主键重复",
        ),
      );
      return;
    }
    seen.add(ticketId);
    const priority = row[config.priorityField] as "P0" | "P1" | "P2";
    const team = row[config.teamField]?.trim();
    if (!["P0", "P1", "P2"].includes(priority)) {
      issues.push(
        issue(
          rowNumber,
          ticketId,
          "invalid_priority",
          "优先级必须是 P0、P1 或 P2",
        ),
      );
      invalid = true;
    }
    let previousEnd: number | null = null;
    const rowMeasurements: StageMeasurement[] = [];
    for (const item of config.stages) {
      const startRaw = row[item.startField]?.trim(),
        endRaw = row[item.endField]?.trim();
      if (!startRaw && !endRaw) {
        rowMeasurements.push(
          makeMeasurement(
            ticketId,
            item,
            priority,
            null,
            null,
            "not_started",
            null,
            null,
          ),
        );
        continue;
      }
      const start = parseTime(startRaw),
        end = parseTime(endRaw);
      if (start === null) {
        issues.push(
          issue(
            rowNumber,
            ticketId,
            "invalid_start",
            `${item.name} 开始时间无效或缺少时区`,
          ),
        );
        invalid = true;
        rowMeasurements.push(
          makeMeasurement(
            ticketId,
            item,
            priority,
            startRaw || null,
            endRaw || null,
            "invalid",
            null,
            null,
          ),
        );
        continue;
      }
      if (start > asOfMs) {
        issues.push(
          issue(
            rowNumber,
            ticketId,
            "future_start",
            `${item.name} 开始时间晚于观测时点`,
          ),
        );
        invalid = true;
      }
      if (previousEnd !== null && start < previousEnd) {
        issues.push(
          issue(
            rowNumber,
            ticketId,
            "stage_overlap",
            `${item.name} 开始时间早于上一环节结束时间`,
          ),
        );
        invalid = true;
      }
      if (endRaw && end === null) {
        issues.push(
          issue(
            rowNumber,
            ticketId,
            "invalid_end",
            `${item.name} 结束时间无效或缺少时区`,
          ),
        );
        invalid = true;
      }
      if (end !== null && (end < start || end > asOfMs)) {
        issues.push(
          issue(
            rowNumber,
            ticketId,
            "invalid_range",
            `${item.name} 时间范围无效`,
          ),
        );
        invalid = true;
      }
      const state = end !== null ? "completed" : "active",
        hours = ((end ?? asOfMs) - start) / 3_600_000;
      const sla = resolveSlaHours(config, item, priority, team);
      rowMeasurements.push(
        makeMeasurement(
          ticketId,
          item,
          priority,
          startRaw,
          endRaw || null,
          state,
          hours,
          hours > sla,
          sla,
        ),
      );
      previousEnd = end;
    }
    if (!invalid) {
      validRows.push(row);
      measurements.push(...rowMeasurements);
    }
  });
  return { validRows, measurements, issues };
}

const issue = (
  row: number,
  ticketId: string | undefined,
  code: string,
  message: string,
): ImportIssue => ({ row, ticketId, code, message, severity: "error" });

function makeMeasurement(
  ticketId: string,
  item: ProcessConfig["stages"][number],
  priority: "P0" | "P1" | "P2",
  startedAt: string | null,
  endedAt: string | null,
  state: StageMeasurement["state"],
  hours: number | null,
  overdue: boolean | null,
  slaHours?: number,
): StageMeasurement {
  return {
    ticketId,
    stageId: item.id,
    stageName: item.name,
    stageType: item.type,
    priority,
    startedAt,
    endedAt,
    state,
    hours,
    slaHours: slaHours ?? item.slaHours[priority] ?? item.slaHours.P1,
    overdue,
  };
}

export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}

export function summarizeStages(
  measurements: StageMeasurement[],
  config: ProcessConfig,
  team?: string,
  comparisonPriority: "P0" | "P1" | "P2" = "P1",
): StageSummary[] {
  return config.stages.map((item) => {
    const all = measurements.filter((m) => m.stageId === item.id),
      completed = all.filter(
        (m) => m.state === "completed" && m.hours !== null,
      ),
      active = all.filter((m) => m.state === "active" && m.hours !== null);
    const values = completed.map((m) => m.hours as number),
      completedOverdueCount = completed.filter((m) => m.overdue).length,
      completedOverdueRate = completed.length
        ? completedOverdueCount / completed.length
        : null,
      slaAchievementRate = completed.length
        ? completed.filter((m) => !m.overdue).length / completed.length
        : null,
      p90Hours = percentile(values, 0.9),
      p0ActiveOverdueCount = active.filter(
        (m) => m.priority === "P0" && m.overdue,
      ).length;
    const p1SlaHours = resolveSlaHours(config, item, "P1", team);
    const comparisonSlaHours = resolveSlaHours(
      config,
      item,
      comparisonPriority,
      team,
    );
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      completedCount: completed.length,
      activeCount: active.length,
      meanHours: values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : null,
      p50Hours: percentile(values, 0.5),
      p90Hours,
      completedOverdueCount,
      completedOverdueRate,
      slaAchievementRate,
      activeOverdueCount: active.filter((m) => m.overdue).length,
      p0ActiveOverdueCount,
      p1SlaHours,
      comparisonSlaHours,
      abnormal:
        (completedOverdueRate ?? 0) > 0.3 ||
        (p90Hours ?? 0) > comparisonSlaHours ||
        p0ActiveOverdueCount > 0,
    };
  });
}

export function summarizeDashboard(
  rows: Record<string, string>[],
  measurements: StageMeasurement[],
  config: ProcessConfig,
  totalRows = rows.length,
): DashboardSummary {
  const first = config.stages[0],
    last = config.stages.at(-1)!;
  const leadTimes = rows.flatMap((row) => {
    const start = parseTime(row[first.startField]),
      end = parseTime(row[last.endField]);
    return start !== null && end !== null ? [(end - start) / 3_600_000] : [];
  });
  const completed = measurements.filter((m) => m.state === "completed"),
    outcomes = rows.filter((row) =>
      ["success", "failed"].includes(row[config.outcomeField]),
    );
  return {
    ticketCount: rows.length,
    completedTicketCount: leadTimes.length,
    meanLeadTimeHours: leadTimes.length
      ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length
      : null,
    p90LeadTimeHours: percentile(leadTimes, 0.9),
    stageOverdueRate: completed.length
      ? completed.filter((m) => m.overdue).length / completed.length
      : null,
    releaseSuccessRate: outcomes.length
      ? outcomes.filter((row) => row[config.outcomeField] === "success")
          .length / outcomes.length
      : null,
    dataValidRate: totalRows ? rows.length / totalRows : null,
  };
}
