import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ProcessConfig,
  StageMeasurement,
} from "../../../packages/contracts/v01.js";

const dataDir = path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const databasePath = process.env.SQLITE_DATABASE_PATH
  ? path.resolve(process.env.SQLITE_DATABASE_PATH)
  : path.join(dataDir, "demo.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
export const db = new DatabaseSync(databasePath);

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS process_spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, imported_at TEXT NOT NULL,
    as_of TEXT NOT NULL, total_rows INTEGER NOT NULL, valid_rows INTEGER NOT NULL, error_rows INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS import_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, row_number INTEGER NOT NULL,
    ticket_id TEXT, code TEXT NOT NULL, message TEXT NOT NULL,
    FOREIGN KEY(batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS work_items (
    ticket_id TEXT PRIMARY KEY, title TEXT NOT NULL, team TEXT NOT NULL, priority TEXT NOT NULL,
    current_status TEXT NOT NULL, release_result TEXT, source_json TEXT NOT NULL, batch_id INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stage_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, stage_id TEXT NOT NULL, stage_name TEXT NOT NULL,
    stage_type TEXT NOT NULL, priority TEXT NOT NULL, started_at TEXT, ended_at TEXT, state TEXT NOT NULL,
    hours REAL, sla_hours REAL NOT NULL, overdue INTEGER,
    FOREIGN KEY(ticket_id) REFERENCES work_items(ticket_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_stage_observations_stage ON stage_observations(stage_id);
  CREATE TABLE IF NOT EXISTS problems (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, stage_id TEXT NOT NULL, impact TEXT NOT NULL,
    owner TEXT NOT NULL, team TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '新建', due_date TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS problem_work_items (
    problem_id INTEGER NOT NULL, ticket_id TEXT NOT NULL, PRIMARY KEY(problem_id, ticket_id),
    FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS reasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT, problem_id INTEGER NOT NULL, ticket_id TEXT,
    category TEXT NOT NULL, detail TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, problem_id INTEGER NOT NULL, content TEXT NOT NULL,
    owner TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT '计划中', expected_change TEXT NOT NULL,
    FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, problem_id INTEGER NOT NULL, baseline_window TEXT NOT NULL,
    after_window TEXT NOT NULL, metric TEXT NOT NULL, guardrail TEXT NOT NULL, conclusion TEXT NOT NULL,
    notes TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS operational_reasons (
    ticket_id TEXT NOT NULL, stage_id TEXT NOT NULL, kind TEXT NOT NULL,
    category TEXT NOT NULL, detail TEXT NOT NULL, responsible_team TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '', due_date TEXT, status TEXT NOT NULL DEFAULT '已填写', updated_at TEXT NOT NULL,
    PRIMARY KEY(ticket_id, stage_id, kind)
  );
  CREATE TABLE IF NOT EXISTS import_batch_records (
    batch_id INTEGER NOT NULL, ticket_id TEXT NOT NULL, classification TEXT NOT NULL,
    source_json TEXT NOT NULL, measurements_json TEXT NOT NULL,
    PRIMARY KEY(batch_id, ticket_id),
    FOREIGN KEY(batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS process_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, version_no INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL, config_json TEXT NOT NULL, change_note TEXT NOT NULL,
    created_at TEXT NOT NULL, published_at TEXT
  );
`);
db.prepare(
  `INSERT INTO process_spaces(name, code, description, owner, status, is_default, created_at, updated_at)
   SELECT ?, ?, ?, ?, 'ACTIVE', 1, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM process_spaces)`,
).run(
  "默认流程",
  "default",
  "承接 V0.3 既有数据的默认流程空间",
  "",
  new Date().toISOString(),
  new Date().toISOString(),
);
const processVersionColumns = db
  .prepare("PRAGMA table_info(process_versions)")
  .all() as Array<{ name: string }>;
if (!processVersionColumns.some((column) => column.name === "baselines_json"))
  db.exec("ALTER TABLE process_versions ADD COLUMN baselines_json TEXT");

const batchColumns = db
  .prepare("PRAGMA table_info(import_batches)")
  .all() as Array<{ name: string }>;
const ensureBatchColumn = (name: string, definition: string) => {
  if (!batchColumns.some((column) => column.name === name))
    db.exec(`ALTER TABLE import_batches ADD COLUMN ${name} ${definition}`);
};
ensureBatchColumn("status", "TEXT NOT NULL DEFAULT 'PUBLISHED'");
ensureBatchColumn("config_json", "TEXT");
ensureBatchColumn("new_rows", "INTEGER NOT NULL DEFAULT 0");
ensureBatchColumn("updated_rows", "INTEGER NOT NULL DEFAULT 0");
ensureBatchColumn("unchanged_rows", "INTEGER NOT NULL DEFAULT 0");
ensureBatchColumn("published_at", "TEXT");
ensureBatchColumn("config_version_id", "INTEGER");
ensureBatchColumn("structure_diff_json", "TEXT");
ensureBatchColumn("structure_override_confirmed_at", "TEXT");

const observationColumns = db
  .prepare("PRAGMA table_info(stage_observations)")
  .all() as Array<{ name: string }>;
const ensureObservationColumn = (name: string, definition: string) => {
  if (!observationColumns.some((column) => column.name === name))
    db.exec(`ALTER TABLE stage_observations ADD COLUMN ${name} ${definition}`);
};
ensureObservationColumn("is_current", "INTEGER NOT NULL DEFAULT 1");
ensureObservationColumn("batch_id", "INTEGER");
ensureObservationColumn("config_version_id", "INTEGER");

const problemColumns = db
  .prepare("PRAGMA table_info(problems)")
  .all() as Array<{
  name: string;
}>;
if (!problemColumns.some((column) => column.name === "due_date"))
  db.exec("ALTER TABLE problems ADD COLUMN due_date TEXT");
if (!problemColumns.some((column) => column.name === "team"))
  db.exec("ALTER TABLE problems ADD COLUMN team TEXT NOT NULL DEFAULT ''");

const reasonColumns = db
  .prepare("PRAGMA table_info(operational_reasons)")
  .all() as Array<{ name: string }>;
const ensureReasonColumn = (name: string, definition: string) => {
  if (!reasonColumns.some((column) => column.name === name))
    db.exec(`ALTER TABLE operational_reasons ADD COLUMN ${name} ${definition}`);
};
ensureReasonColumn("responsible_team", "TEXT NOT NULL DEFAULT ''");
ensureReasonColumn("owner", "TEXT NOT NULL DEFAULT ''");
ensureReasonColumn("due_date", "TEXT");
ensureReasonColumn("status", "TEXT NOT NULL DEFAULT '已填写'");

export function listProcessSpaces() {
  return db
    .prepare(
      `SELECT id, name, code, description, owner, status, is_default, created_at, updated_at
       FROM process_spaces ORDER BY is_default DESC, id`,
    )
    .all();
}

export function createProcessSpace(input: {
  name: string;
  code: string;
  description: string;
  owner: string;
}) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO process_spaces(name, code, description, owner, status, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', 0, ?, ?)`,
    )
    .run(input.name, input.code, input.description, input.owner, now, now);
  return { id: Number(result.lastInsertRowid) };
}

export function updateProcessSpaceStatus(
  id: number,
  status: "ACTIVE" | "INACTIVE",
) {
  const space = db
    .prepare("SELECT is_default FROM process_spaces WHERE id = ?")
    .get(id) as { is_default: number } | undefined;
  if (!space) throw new Error("流程空间不存在");
  if (space.is_default && status === "INACTIVE")
    throw new Error("默认流程空间不能停用");
  db.prepare(
    "UPDATE process_spaces SET status = ?, updated_at = ? WHERE id = ?",
  ).run(status, new Date().toISOString(), id);
}

export function listImportBatches() {
  return db
    .prepare(
      `SELECT id, filename, imported_at, published_at, status, total_rows,
       valid_rows, error_rows, new_rows, updated_rows, unchanged_rows,
       config_version_id, structure_diff_json
       FROM import_batches ORDER BY id DESC`,
    )
    .all();
}

export function listProcessVersions() {
  return db
    .prepare(
      `SELECT id, version_no, status, change_note, created_at, published_at
       FROM process_versions ORDER BY version_no DESC`,
    )
    .all();
}

export function createProcessVersionDraft(
  config: ProcessConfig,
  baselines: unknown,
  changeNote: string,
) {
  const next = db
    .prepare(
      "SELECT COALESCE(MAX(version_no), 0) + 1 AS value FROM process_versions",
    )
    .get() as { value: number };
  const result = db
    .prepare(
      `INSERT INTO process_versions(
        version_no, status, config_json, baselines_json, change_note, created_at
      ) VALUES (?, 'DRAFT', ?, ?, ?, ?)`,
    )
    .run(
      next.value,
      JSON.stringify(config),
      JSON.stringify(baselines),
      changeNote,
      new Date().toISOString(),
    );
  return { id: Number(result.lastInsertRowid), versionNo: next.value };
}

export function publishProcessVersion(id: number) {
  const version = db
    .prepare("SELECT * FROM process_versions WHERE id = ?")
    .get(id) as Record<string, any> | undefined;
  if (!version) throw new Error("配置版本不存在");
  if (version.status !== "DRAFT") throw new Error("只有草稿配置可以发布");
  const config = JSON.parse(version.config_json) as ProcessConfig;
  const baselines = version.baselines_json
    ? JSON.parse(version.baselines_json)
    : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE process_versions SET status = 'RETIRED' WHERE status = 'PUBLISHED'",
    ).run();
    db.prepare(
      "UPDATE process_versions SET status = 'PUBLISHED', published_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), id);
    setSetting("process_config", config);
    if (baselines) setSetting("operation_baselines", baselines);
    db.exec("COMMIT");
    return { id, versionNo: version.version_no, published: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getSetting<T>(key: string): T | null {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as T) : null;
}

export function setSetting(key: string, value: unknown) {
  db.prepare(
    "INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(key, JSON.stringify(value));
}

export function listOperationalReasons() {
  return db
    .prepare(
      "SELECT * FROM operational_reasons ORDER BY updated_at DESC, ticket_id",
    )
    .all();
}

export function saveOperationalReason(input: {
  ticketId: string;
  stageId: string;
  kind: string;
  category: string;
  detail: string;
  responsibleTeam: string;
  owner: string;
  dueDate: string;
  status: "待填写" | "已填写";
}) {
  const result = db.prepare(
    `INSERT INTO operational_reasons(ticket_id, stage_id, kind, category, detail, responsible_team, owner, due_date, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticket_id, stage_id, kind) DO UPDATE SET
       category = excluded.category, detail = excluded.detail,
       responsible_team = excluded.responsible_team, owner = excluded.owner,
       due_date = excluded.due_date, status = excluded.status, updated_at = excluded.updated_at`,
  ).run(
    input.ticketId,
    input.stageId,
    input.kind,
    input.category,
    input.detail,
    input.responsibleTeam,
    input.owner,
    input.dueDate,
    input.status,
    new Date().toISOString(),
  );
  return result.changes === 1;
}

export function updateProcessConfig(config: ProcessConfig) {
  db.exec("BEGIN IMMEDIATE");
  try {
    setSetting("process_config", config);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function resetDemo() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM verifications;
      DELETE FROM actions;
      DELETE FROM reasons;
      DELETE FROM problem_work_items;
      DELETE FROM problems;
      DELETE FROM operational_reasons;
      DELETE FROM stage_observations;
      DELETE FROM work_items;
      DELETE FROM import_batch_records;
      DELETE FROM import_issues;
      DELETE FROM import_batches;
      DELETE FROM process_versions;
      DELETE FROM settings WHERE key IN ('process_config', 'operation_baselines');
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function prepareImportBatch(
  filename: string,
  asOf: string,
  totalRows: number,
  rows: Record<string, string>[],
  measurements: StageMeasurement[],
  config: ProcessConfig,
  issues: Array<{
    row: number;
    ticketId?: string;
    code: string;
    message: string;
  }>,
  structureDiff: import("../../../packages/contracts/v01.js").ProcessStructureDiff,
) {
  const currentRows = db
    .prepare("SELECT ticket_id, source_json FROM work_items")
    .all() as Array<{ ticket_id: string; source_json: string }>;
  const current = new Map(
    currentRows.map((row) => [row.ticket_id, row.source_json]),
  );
  const classified = rows.map((row) => {
    const ticketId = row[config.keyField];
    const sourceJson = JSON.stringify(row);
    return {
      ticketId,
      sourceJson,
      classification: !current.has(ticketId)
        ? "new"
        : current.get(ticketId) === sourceJson
          ? "unchanged"
          : "updated",
      measurements: measurements.filter((item) => item.ticketId === ticketId),
    };
  });
  const counts = {
    newRows: classified.filter((row) => row.classification === "new").length,
    updatedRows: classified.filter((row) => row.classification === "updated")
      .length,
    unchangedRows: classified.filter(
      (row) => row.classification === "unchanged",
    ).length,
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const batch = db
      .prepare(
        `INSERT INTO import_batches(
          filename, imported_at, as_of, total_rows, valid_rows, error_rows,
          status, config_json, new_rows, updated_rows, unchanged_rows, structure_diff_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        filename,
        new Date().toISOString(),
        asOf,
        totalRows,
        rows.length,
        issues.length,
        structureDiff.changed
          ? "AWAITING_STRUCTURE_DECISION"
          : issues.length
            ? "READY_WITH_ERRORS"
            : "READY_TO_PUBLISH",
        JSON.stringify(config),
        counts.newRows,
        counts.updatedRows,
        counts.unchangedRows,
        JSON.stringify(structureDiff),
      );
    const batchId = Number(batch.lastInsertRowid);
    const recordInsert = db.prepare(
      "INSERT INTO import_batch_records(batch_id, ticket_id, classification, source_json, measurements_json) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of classified)
      recordInsert.run(
        batchId,
        row.ticketId,
        row.classification,
        row.sourceJson,
        JSON.stringify(row.measurements),
      );
    const issueInsert = db.prepare(
      "INSERT INTO import_issues(batch_id, row_number, ticket_id, code, message) VALUES (?, ?, ?, ?, ?)",
    );
    for (const item of issues)
      issueInsert.run(
        batchId,
        item.row,
        item.ticketId ?? null,
        item.code,
        item.message,
      );
    db.exec("COMMIT");
    return { batchId, ...counts, errorRows: issues.length, structureDiff };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function publishImportBatch(
  batchId: number,
  allowStructureOverride = false,
) {
  const batch = db
    .prepare("SELECT * FROM import_batches WHERE id = ?")
    .get(batchId) as Record<string, any> | undefined;
  if (!batch) throw new Error("导入批次不存在");
  if (batch.status === "AWAITING_STRUCTURE_DECISION" && !allowStructureOverride)
    throw new Error("流程结构发生变化，请先选择放弃导入或确认覆盖流程");
  if (
    ![
      "READY_TO_PUBLISH",
      "READY_WITH_ERRORS",
      "AWAITING_STRUCTURE_DECISION",
    ].includes(batch.status)
  )
    throw new Error("当前批次不能发布");
  const config = JSON.parse(batch.config_json) as ProcessConfig;
  const records = db
    .prepare(
      "SELECT * FROM import_batch_records WHERE batch_id = ? ORDER BY ticket_id",
    )
    .all(batchId) as Array<Record<string, any>>;
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentVersion = db
      .prepare(
        "SELECT * FROM process_versions WHERE status = 'PUBLISHED' ORDER BY version_no DESC LIMIT 1",
      )
      .get() as Record<string, any> | undefined;
    let configVersionId = currentVersion?.id as number | undefined;
    if (!currentVersion || currentVersion.config_json !== batch.config_json) {
      if (currentVersion)
        db.prepare(
          "UPDATE process_versions SET status='RETIRED' WHERE status='PUBLISHED'",
        ).run();
      const nextVersion = Number(currentVersion?.version_no ?? 0) + 1;
      const now = new Date().toISOString();
      const result = db
        .prepare(
          `INSERT INTO process_versions(version_no, status, config_json, change_note, created_at, published_at)
           VALUES (?, 'PUBLISHED', ?, ?, ?, ?)`,
        )
        .run(
          nextVersion,
          batch.config_json,
          currentVersion ? `随导入批次 #${batchId} 发布` : "首次配置发布",
          now,
          now,
        );
      configVersionId = Number(result.lastInsertRowid);
    }
    if (!configVersionId) throw new Error("无法确定配置版本");
    const upsert = db.prepare(
      `INSERT INTO work_items(ticket_id, title, team, priority, current_status, release_result, source_json, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticket_id) DO UPDATE SET title=excluded.title, team=excluded.team,
       priority=excluded.priority, current_status=excluded.current_status,
       release_result=excluded.release_result, source_json=excluded.source_json, batch_id=excluded.batch_id`,
    );
    const supersedeObservations = db.prepare(
      "UPDATE stage_observations SET is_current = 0 WHERE ticket_id = ? AND is_current = 1",
    );
    const observationInsert = db.prepare(
      "INSERT INTO stage_observations(ticket_id, stage_id, stage_name, stage_type, priority, started_at, ended_at, state, hours, sla_hours, overdue, is_current, batch_id, config_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    );
    for (const record of records) {
      if (record.classification === "unchanged") continue;
      const row = JSON.parse(record.source_json) as Record<string, string>;
      upsert.run(
        record.ticket_id,
        row[config.titleField] ?? "",
        row[config.teamField] ?? "",
        row[config.priorityField] ?? "",
        row[config.statusField] ?? "",
        row[config.outcomeField] ?? "",
        record.source_json,
        batchId,
      );
      supersedeObservations.run(record.ticket_id);
      const observations = JSON.parse(
        record.measurements_json,
      ) as StageMeasurement[];
      for (const item of observations)
        observationInsert.run(
          item.ticketId,
          item.stageId,
          item.stageName,
          item.stageType,
          item.priority,
          item.startedAt,
          item.endedAt,
          item.state,
          item.hours,
          item.slaHours,
          item.overdue === null ? null : Number(item.overdue),
          batchId,
          configVersionId,
        );
    }
    setSetting("process_config", config);
    db.prepare(
      "UPDATE import_batches SET status = 'PUBLISHED', published_at = ?, config_version_id = ?, structure_override_confirmed_at = ? WHERE id = ?",
    ).run(
      new Date().toISOString(),
      configVersionId,
      allowStructureOverride ? new Date().toISOString() : null,
      batchId,
    );
    db.exec("COMMIT");
    return { batchId, published: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function rejectImportBatch(batchId: number) {
  const result = db
    .prepare(
      "UPDATE import_batches SET status='REJECTED' WHERE id=? AND status='AWAITING_STRUCTURE_DECISION'",
    )
    .run(batchId);
  if (!result.changes) throw new Error("当前批次不能放弃");
}

export function replaceSnapshot(
  filename: string,
  asOf: string,
  totalRows: number,
  rows: Record<string, string>[],
  measurements: StageMeasurement[],
  config: ProcessConfig,
  issues: Array<{
    row: number;
    ticketId?: string;
    code: string;
    message: string;
  }>,
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const batch = db
      .prepare(
        "INSERT INTO import_batches(filename, imported_at, as_of, total_rows, valid_rows, error_rows) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        filename,
        new Date().toISOString(),
        asOf,
        totalRows,
        rows.length,
        issues.length,
      );
    const batchId = Number(batch.lastInsertRowid);
    const issueInsert = db.prepare(
      "INSERT INTO import_issues(batch_id, row_number, ticket_id, code, message) VALUES (?, ?, ?, ?, ?)",
    );
    for (const item of issues)
      issueInsert.run(
        batchId,
        item.row,
        item.ticketId ?? null,
        item.code,
        item.message,
      );
    db.exec("DELETE FROM stage_observations; DELETE FROM work_items;");
    const itemInsert = db.prepare(
      "INSERT INTO work_items(ticket_id, title, team, priority, current_status, release_result, source_json, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows)
      itemInsert.run(
        row[config.keyField],
        row[config.titleField] ?? "",
        row[config.teamField] ?? "",
        row[config.priorityField] ?? "",
        row[config.statusField] ?? "",
        row[config.outcomeField] ?? "",
        JSON.stringify(row),
        batchId,
      );
    const observationInsert = db.prepare(
      "INSERT INTO stage_observations(ticket_id, stage_id, stage_name, stage_type, priority, started_at, ended_at, state, hours, sla_hours, overdue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of measurements)
      observationInsert.run(
        item.ticketId,
        item.stageId,
        item.stageName,
        item.stageType,
        item.priority,
        item.startedAt,
        item.endedAt,
        item.state,
        item.hours,
        item.slaHours,
        item.overdue === null ? null : Number(item.overdue),
      );
    setSetting("process_config", config);
    db.exec("COMMIT");
    return batchId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listProblems() {
  const problems = db
    .prepare("SELECT * FROM problems ORDER BY id DESC")
    .all() as Array<Record<string, unknown>>;
  const ticketStmt = db.prepare(
    "SELECT ticket_id FROM problem_work_items WHERE problem_id = ?",
  );
  const reasonStmt = db.prepare(
    "SELECT * FROM reasons WHERE problem_id = ? ORDER BY id DESC",
  );
  const actionStmt = db.prepare(
    "SELECT * FROM actions WHERE problem_id = ? ORDER BY id DESC",
  );
  const verificationStmt = db.prepare(
    "SELECT * FROM verifications WHERE problem_id = ? ORDER BY id DESC",
  );
  return problems.map((problem) => {
    const id = Number(problem.id);
    return {
      ...problem,
      ticketIds: (ticketStmt.all(id) as Array<{ ticket_id: string }>).map(
        (row) => row.ticket_id,
      ),
      reasons: reasonStmt.all(id),
      actions: actionStmt.all(id),
      verifications: verificationStmt.all(id),
    };
  });
}

export function listWorkItemsRaw() {
  return db
    .prepare("SELECT * FROM work_items ORDER BY ticket_id")
    .all() as Array<Record<string, any>>;
}

export function listStageObservationsForTickets(ticketIds: string[]) {
  if (!ticketIds.length) return [];
  const placeholders = ticketIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM stage_observations WHERE ticket_id IN (${placeholders}) AND is_current = 1 ORDER BY ticket_id, id`,
    )
    .all(...ticketIds) as Array<Record<string, any>>;
}

export function getLatestPublishedBatch() {
  return db
    .prepare(
      "SELECT * FROM import_batches WHERE status = 'PUBLISHED' ORDER BY id DESC LIMIT 1",
    )
    .get() as Record<string, any> | undefined;
}

export function listWorkItemTeams() {
  return (
    db
      .prepare("SELECT DISTINCT team FROM work_items ORDER BY team")
      .all() as Array<{
      team: string;
    }>
  ).map((row) => row.team);
}

export function getSampleSource() {
  return db.prepare("SELECT source_json FROM work_items LIMIT 1").get() as
    { source_json: string } | undefined;
}

export function listStageObservationsForStage(stageId: string) {
  return db
    .prepare(
      "SELECT * FROM stage_observations WHERE stage_id = ? AND is_current = 1 ORDER BY overdue DESC, hours DESC",
    )
    .all(stageId) as Array<Record<string, any>>;
}

export function getWorkItemWithObservations(ticketId: string) {
  const item = db
    .prepare("SELECT * FROM work_items WHERE ticket_id = ?")
    .get(ticketId) as Record<string, any> | undefined;
  if (!item) return null;
  return {
    ...item,
    source: JSON.parse(item.source_json),
    observations: db
      .prepare(
        "SELECT * FROM stage_observations WHERE ticket_id = ? AND is_current = 1 ORDER BY id",
      )
      .all(ticketId),
  };
}

export function createProblem(input: {
  title: string;
  stageId: string;
  impact: string;
  owner: string;
  team: string;
  ticketIds: string[];
}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db
      .prepare(
        "INSERT INTO problems(title, stage_id, impact, owner, team, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.title,
        input.stageId,
        input.impact,
        input.owner,
        input.team,
        "新建",
        new Date().toISOString(),
      );
    const id = Number(result.lastInsertRowid);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO problem_work_items(problem_id, ticket_id) VALUES (?, ?)",
    );
    for (const ticketId of input.ticketIds) insert.run(id, ticketId);
    db.exec("COMMIT");
    return id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function addProblemReason(
  problemId: number,
  input: {
    ticketId?: string;
    category: string;
    detail: string;
    author: string;
  },
) {
  db.prepare(
    "INSERT INTO reasons(problem_id, ticket_id, category, detail, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    problemId,
    input.ticketId || null,
    input.category,
    input.detail,
    input.author,
    new Date().toISOString(),
  );
}

export function addProblemAction(
  problemId: number,
  input: {
    content: string;
    owner: string;
    dueDate?: string;
    expectedChange: string;
  },
) {
  db.prepare(
    "INSERT INTO actions(problem_id, content, owner, due_date, status, expected_change) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    problemId,
    input.content,
    input.owner,
    input.dueDate || null,
    "计划中",
    input.expectedChange,
  );
}

export function addProblemVerification(
  problemId: number,
  input: {
    baselineWindow: string;
    afterWindow: string;
    metric: string;
    guardrail: string;
    conclusion: string;
    notes: string;
  },
) {
  db.prepare(
    "INSERT INTO verifications(problem_id, baseline_window, after_window, metric, guardrail, conclusion, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    problemId,
    input.baselineWindow,
    input.afterWindow,
    input.metric,
    input.guardrail,
    input.conclusion,
    input.notes,
    new Date().toISOString(),
  );
}

export function updateProblemStatus(
  problemId: number,
  status: string,
  dueDate?: string,
) {
  const result = db
    .prepare(
      "UPDATE problems SET status = ?, due_date = COALESCE(?, due_date) WHERE id = ?",
    )
    .run(status, dueDate ?? null, problemId);
  return result.changes === 1;
}

export function updateProblem(
  problemId: number,
  input: {
    title: string;
    impact: string;
    owner: string;
    team: string;
    dueDate?: string;
  },
) {
  const result = db
    .prepare(
      "UPDATE problems SET title=?, impact=?, owner=?, team=?, due_date=? WHERE id=?",
    )
    .run(
      input.title,
      input.impact,
      input.owner,
      input.team,
      input.dueDate || null,
      problemId,
    );
  return result.changes === 1;
}

export function updateProblemActionStatus(
  problemId: number,
  actionId: number,
  status: string,
) {
  const result = db
    .prepare("UPDATE actions SET status = ? WHERE id = ? AND problem_id = ?")
    .run(status, actionId, problemId);
  return result.changes === 1;
}
