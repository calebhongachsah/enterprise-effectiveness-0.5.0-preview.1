import { Client } from "pg";
import crypto from "node:crypto";
import type { ProcessConfig } from "../../../packages/contracts/v01.js";
import { validateConfig } from "../../../packages/core/v01.js";
import {
  compareProcessStructure,
  normalizeRows,
} from "../../../packages/core/v01.js";
import { postgresStorage } from "./postgres-storage.js";
import { connectionPool } from "./postgres.js";
import {
  decryptDataSourceSecret,
  encryptDataSourceSecret,
} from "./data-source-crypto.js";

type DataSourceInput = {
  name: string;
  host: string;
  port?: number;
  databaseName: string;
  username: string;
  password: string;
  sslMode?: "VERIFY_FULL" | "REQUIRE" | "DISABLE";
};

export type SourceColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  ordinal_position: number;
};

export type SchemaDrift = {
  changed: boolean;
  blocking: boolean;
  added: string[];
  removed: string[];
  removedMapped: string[];
  typeChangedMapped: Array<{ field: string; before: string; after: string }>;
};

function typeFamily(value: string) {
  const type = value.toLowerCase();
  if (["text", "character varying", "character", "citext"].includes(type))
    return "text";
  if (
    [
      "smallint",
      "integer",
      "bigint",
      "numeric",
      "decimal",
      "real",
      "double precision",
    ].includes(type)
  )
    return "number";
  if (type === "timestamp with time zone") return "timestamp_tz";
  if (type === "timestamp without time zone") return "timestamp_no_tz";
  return type;
}

export function analyzeSchemaDrift(
  expected: SourceColumn[],
  current: SourceColumn[],
  mappedFields: string[],
): SchemaDrift {
  const before = new Map(
    expected.map((column) => [column.column_name, column]),
  );
  const after = new Map(current.map((column) => [column.column_name, column]));
  const mapped = new Set(mappedFields);
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const removedMapped = removed.filter((name) => mapped.has(name));
  const typeChangedMapped = [...mapped].flatMap((field) => {
    const oldColumn = before.get(field);
    const newColumn = after.get(field);
    return oldColumn &&
      newColumn &&
      typeFamily(oldColumn.data_type) !== typeFamily(newColumn.data_type)
      ? [{ field, before: oldColumn.data_type, after: newColumn.data_type }]
      : [];
  });
  const changed =
    added.length > 0 ||
    removed.length > 0 ||
    expected.some((column) => {
      const next = after.get(column.column_name);
      return (
        next && typeFamily(column.data_type) !== typeFamily(next.data_type)
      );
    });
  return {
    changed,
    blocking: removedMapped.length > 0 || typeChangedMapped.length > 0,
    added,
    removed,
    removedMapped,
    typeChangedMapped,
  };
}

const appPool = () => {
  const value = connectionPool();
  if (!value) throw new Error("数据源管理仅可在 PostgreSQL 模式使用");
  return value;
};

function cleanInput(input: DataSourceInput) {
  const value = {
    name: String(input.name ?? "").trim(),
    host: String(input.host ?? "").trim(),
    port: Number(input.port ?? 5432),
    databaseName: String(input.databaseName ?? "").trim(),
    username: String(input.username ?? "").trim(),
    password: String(input.password ?? ""),
    sslMode: input.sslMode ?? "VERIFY_FULL",
  };
  if (!value.name || !value.host || !value.databaseName || !value.username)
    throw new Error("数据源名称、地址、数据库和用户名均为必填");
  if (!value.password) throw new Error("数据库密码不能为空");
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
    throw new Error("数据库端口必须在 1 到 65535 之间");
  if (!(["VERIFY_FULL", "REQUIRE", "DISABLE"] as const).includes(value.sslMode))
    throw new Error("SSL 模式无效");
  return value;
}

// Import and publication still use the single default warehouse during the migration.
const defaultProcessSpace = "(SELECT id FROM process_spaces WHERE is_default AND status='ACTIVE')";

export async function listDataSources() {
  return (
    await appPool().query(
      `SELECT ds.id, ps.code AS process_id, ds.name, ds.connector_type, ds.status,
       ds.host, ds.port, ds.database_name, ds.username, ds.ssl_mode,
       ds.source_schema, ds.source_object, ds.source_object_kind,
       ds.business_key_field, ds.updated_at_field, ds.mapping_json,
       ds.schedule_json, ds.mapping_version, ds.last_schema_fingerprint,
       ds.created_at, ds.updated_at, (dss.data_source_id IS NOT NULL) AS has_secret,
       latest.id AS latest_sync_run_id, latest.status AS latest_sync_status,
       latest.run_type AS latest_sync_run_type,
       latest.rows_read AS latest_rows_read, latest.rows_rejected AS latest_rows_rejected,
       latest.import_batch_id AS latest_import_batch_id
       FROM data_sources ds
       JOIN process_spaces ps ON ps.id = ds.process_space_id
       LEFT JOIN data_source_secrets dss ON dss.data_source_id = ds.id
       LEFT JOIN LATERAL (
         SELECT id, run_type, status, rows_read, rows_rejected, import_batch_id
         FROM sync_runs WHERE data_source_id = ds.id ORDER BY id DESC LIMIT 1
       ) latest ON true
       WHERE ds.process_space_id = ${defaultProcessSpace}
       ORDER BY ds.id`,
    )
  ).rows;
}

export async function listSyncRuns(dataSourceId?: number) {
  return (
    await appPool().query(
      `SELECT sr.id, sr.data_source_id, ds.name AS data_source_name,
       sr.import_batch_id, sr.run_type, sr.trigger_type, sr.status,
       sr.started_at, sr.finished_at, sr.rows_read, sr.rows_new,
       sr.rows_updated, sr.rows_unchanged, sr.rows_rejected,
       sr.attempt_no, sr.error_code, sr.error_summary,
       sr.cursor_start_json, sr.cursor_end_json, sr.schema_change_json
       FROM sync_runs sr JOIN data_sources ds ON ds.id = sr.data_source_id
       WHERE ds.process_space_id = ${defaultProcessSpace}
         AND ($1::bigint IS NULL OR sr.data_source_id = $1)
       ORDER BY sr.id DESC LIMIT 100`,
      [dataSourceId ?? null],
    )
  ).rows;
}

export async function getSyncRunDetails(id: number) {
  const run = (
    await appPool().query<any>(
      `SELECT sr.*, ds.name AS data_source_name
       FROM sync_runs sr JOIN data_sources ds ON ds.id=sr.data_source_id
       WHERE sr.id=$1 AND ds.process_space_id = ${defaultProcessSpace}`,
      [id],
    )
  ).rows[0];
  if (!run) return null;
  const issues = run.import_batch_id
    ? (
        await appPool().query(
          `SELECT row_number, ticket_id, code, message
           FROM import_issues WHERE batch_id=$1 ORDER BY row_number LIMIT 100`,
          [run.import_batch_id],
        )
      ).rows
    : [];
  return { run, issues };
}

export async function createDataSource(
  input: DataSourceInput,
  actorId?: number,
) {
  const value = cleanInput(input);
  const encrypted = encryptDataSourceSecret(value.password);
  const client = await appPool().connect();
  try {
    await client.query("BEGIN");
    const created = await client.query<{ id: string }>(
      `INSERT INTO data_sources(process_space_id, name, connector_type, host, port, database_name,
       username, ssl_mode, created_by)
       VALUES (${defaultProcessSpace}, $1, 'POSTGRESQL', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        value.name,
        value.host,
        value.port,
        value.databaseName,
        value.username,
        value.sslMode,
        actorId ?? null,
      ],
    );
    const id = Number(created.rows[0].id);
    await client.query(
      `INSERT INTO data_source_secrets(data_source_id, encrypted_value,
       initialization_vector, authentication_tag, key_version)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        encrypted.encryptedValue,
        encrypted.initializationVector,
        encrypted.authenticationTag,
        encrypted.keyVersion,
      ],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505")
      throw new Error("这个数据源名称已经存在，请直接继续配置已有连接");
    throw error;
  } finally {
    client.release();
  }
}

async function sourceConnection(id: number) {
  const found = await appPool().query<any>(
    `SELECT ds.*, dss.encrypted_value, dss.initialization_vector,
     dss.authentication_tag, dss.key_version
     FROM data_sources ds JOIN data_source_secrets dss ON dss.data_source_id = ds.id
     WHERE ds.id = $1 AND ds.process_space_id = ${defaultProcessSpace}`,
    [id],
  );
  const source = found.rows[0];
  if (!source) throw new Error("数据源不存在或尚未配置凭据");
  const password = decryptDataSourceSecret({
    encryptedValue: source.encrypted_value,
    initializationVector: source.initialization_vector,
    authenticationTag: source.authentication_tag,
    keyVersion: source.key_version,
  });
  const ssl =
    source.ssl_mode === "DISABLE"
      ? false
      : source.ssl_mode === "REQUIRE"
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true };
  const client = new Client({
    host: source.host,
    port: source.port,
    database: source.database_name,
    user: source.username,
    password,
    ssl,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: "effectiveness-data-source",
    options: "-c default_transaction_read_only=on",
  });
  return { client, source };
}

async function withSource<T>(id: number, run: (client: Client) => Promise<T>) {
  const { client } = await sourceConnection(id);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function mappedSourceFields(config: ProcessConfig, updatedAtField: string) {
  return [
    config.keyField,
    config.titleField,
    config.teamField,
    config.priorityField,
    config.statusField,
    config.outcomeField,
    updatedAtField,
    ...config.stages.flatMap((stage) => [stage.startField, stage.endField]),
  ].filter(Boolean);
}

async function inspectSchemaDrift(id: number, source: any) {
  const current = await withSource(id, async (client) => {
    const columns = await client.query<SourceColumn>(
      `SELECT column_name, data_type, is_nullable, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [source.source_schema, source.source_object],
    );
    return columns.rows;
  });
  const mapping = source.mapping_json as {
    processConfig: ProcessConfig;
    updatedAtField: string;
  };
  const drift = analyzeSchemaDrift(
    source.source_schema_json as SourceColumn[],
    current,
    mappedSourceFields(mapping.processConfig, mapping.updatedAtField),
  );
  return drift;
}

function schemaDriftSummary(drift: SchemaDrift) {
  const messages: string[] = [];
  if (drift.removedMapped.length)
    messages.push(`已映射字段缺失：${drift.removedMapped.join("、")}`);
  if (drift.typeChangedMapped.length)
    messages.push(
      `已映射字段类型变化：${drift.typeChangedMapped
        .map((item) => `${item.field}（${item.before} → ${item.after}）`)
        .join("、")}`,
    );
  if (drift.added.length) messages.push(`新增字段：${drift.added.join("、")}`);
  return messages.join("；") || "源数据结构未变化";
}

export async function testDataSource(id: number) {
  return withSource(id, async (client) => {
    const result = await client.query<{
      database_name: string;
      username: string;
      version: string;
      read_only: string;
    }>(
      `SELECT current_database() AS database_name, current_user AS username,
       current_setting('server_version') AS version,
       current_setting('transaction_read_only') AS read_only`,
    );
    return {
      connected: true,
      databaseName: result.rows[0].database_name,
      username: result.rows[0].username,
      serverVersion: result.rows[0].version,
      sessionReadOnly: result.rows[0].read_only === "on",
    };
  });
}

export async function listSourceObjects(id: number) {
  return withSource(id, async (client) => {
    const result = await client.query<{
      schema_name: string;
      object_name: string;
      object_kind: "TABLE" | "VIEW";
    }>(
      `SELECT table_schema AS schema_name, table_name AS object_name,
       CASE WHEN table_type = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS object_kind
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`,
    );
    return result.rows;
  });
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function previewSourceObject(
  id: number,
  schemaName: string,
  objectName: string,
) {
  return withSource(id, async (client) => {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, objectName],
    );
    if (!exists.rowCount)
      throw new Error("所选表或视图不存在，或当前账号无权读取");
    const columns = await client.query(
      `SELECT column_name, data_type, is_nullable, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schemaName, objectName],
    );
    const rows = await client.query(
      `SELECT * FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)} LIMIT 20`,
    );
    return {
      columns: columns.rows,
      preview: rows.rows,
      rowCount: rows.rowCount,
    };
  });
}

export async function configureDataSource(
  id: number,
  input: {
    schemaName: string;
    objectName: string;
    updatedAtField: string;
    config: ProcessConfig;
  },
  actorId?: number,
) {
  const schemaName = String(input.schemaName ?? "").trim();
  const objectName = String(input.objectName ?? "").trim();
  const updatedAtField = String(input.updatedAtField ?? "").trim();
  if (!schemaName || !objectName || !updatedAtField || !input.config)
    throw new Error("数据对象、增量更新时间和字段映射均为必填");
  const metadata = await withSource(id, async (client) => {
    const object = await client.query<{ object_kind: "TABLE" | "VIEW" }>(
      `SELECT CASE WHEN table_type = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS object_kind
       FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, objectName],
    );
    if (!object.rowCount)
      throw new Error("所选表或视图不存在，或当前账号无权读取");
    const columns = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      ordinal_position: number;
    }>(
      `SELECT column_name, data_type, is_nullable, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schemaName, objectName],
    );
    return { objectKind: object.rows[0].object_kind, columns: columns.rows };
  });
  const headers = metadata.columns.map((column) => column.column_name);
  const errors = validateConfig(input.config, headers);
  if (!headers.includes(updatedAtField))
    errors.push(`未找到增量更新时间字段：${updatedAtField}`);
  if (input.config.keyField === updatedAtField)
    errors.push("业务主键与增量更新时间必须是不同字段");
  if (errors.length)
    throw Object.assign(new Error("字段映射无法启用"), { details: errors });
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(metadata.columns))
    .digest("hex");
  const mapping = { processConfig: input.config, updatedAtField };
  const client = await appPool().connect();
  try {
    await client.query("BEGIN");
    const source = await client.query<{ mapping_version: number }>(
      `SELECT mapping_version FROM data_sources
       WHERE id = $1 AND process_space_id = ${defaultProcessSpace} FOR UPDATE`,
      [id],
    );
    if (!source.rowCount) throw new Error("数据源不存在");
    const existing = await client.query<{ value: number }>(
      `SELECT COALESCE(MAX(version_no), 0) + 1 AS value
       FROM data_source_mapping_versions WHERE data_source_id = $1`,
      [id],
    );
    const versionNo = Number(existing.rows[0].value);
    await client.query(
      `INSERT INTO data_source_mapping_versions(data_source_id, version_no,
       mapping_json, source_schema_json, schema_fingerprint, created_by, activated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, now())`,
      [
        id,
        versionNo,
        JSON.stringify(mapping),
        JSON.stringify(metadata.columns),
        fingerprint,
        actorId ?? null,
      ],
    );
    await client.query(
      `UPDATE data_sources SET status = 'ACTIVE', source_schema = $2,
       source_object = $3, source_object_kind = $4, business_key_field = $5,
       updated_at_field = $6, mapping_json = $7::jsonb, mapping_version = $8,
       last_schema_fingerprint = $9, updated_at = now() WHERE id = $1`,
      [
        id,
        schemaName,
        objectName,
        metadata.objectKind,
        input.config.keyField,
        updatedAtField,
        JSON.stringify(mapping),
        versionNo,
        fingerprint,
      ],
    );
    await client.query("COMMIT");
    return { id, versionNo, status: "ACTIVE", schemaFingerprint: fingerprint };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateDataSourceSchedule(
  id: number,
  input: {
    enabled: boolean;
    frequency?: "EVERY_15_MINUTES" | "HOURLY" | "DAILY" | "WEEKLY";
    hour?: number;
    minute?: number;
    dayOfWeek?: number;
    timezone?: string;
  },
) {
  const schedule = {
    enabled: Boolean(input.enabled),
    frequency: input.frequency ?? ("DAILY" as const),
    hour: Number(input.hour ?? 2),
    minute: Number(input.minute ?? 0),
    dayOfWeek: Number(input.dayOfWeek ?? 1),
    timezone: String(input.timezone ?? "Asia/Singapore"),
    nextRunAt: null as string | null,
  };
  if (
    !["EVERY_15_MINUTES", "HOURLY", "DAILY", "WEEKLY"].includes(
      schedule.frequency,
    )
  )
    throw new Error("同步频率无效");
  if (
    !Number.isInteger(schedule.hour) ||
    schedule.hour < 0 ||
    schedule.hour > 23
  )
    throw new Error("同步小时必须在 0 到 23 之间");
  if (
    !Number.isInteger(schedule.minute) ||
    schedule.minute < 0 ||
    schedule.minute > 59
  )
    throw new Error("同步分钟必须在 0 到 59 之间");
  if (
    !Number.isInteger(schedule.dayOfWeek) ||
    schedule.dayOfWeek < 1 ||
    schedule.dayOfWeek > 7
  )
    throw new Error("每周同步星期必须在 1 到 7 之间");
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: schedule.timezone }).format();
  } catch {
    throw new Error("同步时区无效");
  }
  schedule.nextRunAt = schedule.enabled
    ? nextScheduledAt(schedule, new Date()).toISOString()
    : null;
  const updated = await appPool().query(
    `UPDATE data_sources SET schedule_json=$2::jsonb, updated_at=now()
     WHERE id=$1 AND status='ACTIVE' AND process_space_id = ${defaultProcessSpace}`,
    [id, JSON.stringify(schedule)],
  );
  if (!updated.rowCount) throw new Error("只有已启用的数据源可以配置定时同步");
  return schedule;
}

function sourceValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function maxCursor(
  rows: Record<string, string>[],
  updatedAtField: string,
  businessKeyField: string,
) {
  return rows.reduce<{ updatedAt: string; businessKey: string } | null>(
    (latest, row) => {
      const updatedAt = row[updatedAtField];
      const businessKey = row[businessKeyField];
      if (!updatedAt || !businessKey) return latest;
      if (
        !latest ||
        updatedAt > latest.updatedAt ||
        (updatedAt === latest.updatedAt && businessKey > latest.businessKey)
      )
        return { updatedAt, businessKey };
      return latest;
    },
    null,
  );
}

export async function runFullSync(
  id: number,
  triggerType: "MANUAL" | "RETRY" = "MANUAL",
  attemptNo = 1,
) {
  const sourceResult = await appPool().query<any>(
    `SELECT ds.*, dsmv.id AS mapping_version_id,
     dsmv.source_schema_json
     FROM data_sources ds
     JOIN data_source_mapping_versions dsmv
       ON dsmv.data_source_id = ds.id AND dsmv.version_no = ds.mapping_version
     WHERE ds.id = $1 AND ds.process_space_id = ${defaultProcessSpace}`,
    [id],
  );
  const source = sourceResult.rows[0];
  if (!source || source.status !== "ACTIVE")
    throw new Error("只有已启用且完成映射的数据源可以同步");
  const active = await appPool().query(
    `SELECT 1 FROM sync_runs WHERE data_source_id = $1 AND status IN
     ('QUEUED','CONNECTING','EXTRACTING','VALIDATING','READY_TO_PUBLISH','PUBLISHING')`,
    [id],
  );
  if (active.rowCount) throw new Error("该数据源已有尚未完成的同步任务");
  const created = await appPool().query<{ id: string }>(
    `INSERT INTO sync_runs(data_source_id, mapping_version_id, run_type,
     trigger_type, status, started_at, attempt_no)
     VALUES ($1, $2, 'FULL', $3, 'CONNECTING', now(), $4) RETURNING id`,
    [id, source.mapping_version_id, triggerType, attemptNo],
  );
  const syncRunId = Number(created.rows[0].id);
  try {
    const schemaChange = await inspectSchemaDrift(id, source);
    if (schemaChange.blocking) {
      await appPool().query(
        `UPDATE sync_runs SET status='SCHEMA_BLOCKED', finished_at=now(),
         error_code='SCHEMA_DRIFT', error_summary=$2,
         schema_change_json=$3::jsonb WHERE id=$1`,
        [
          syncRunId,
          schemaDriftSummary(schemaChange),
          JSON.stringify(schemaChange),
        ],
      );
      return {
        syncRunId,
        status: "SCHEMA_BLOCKED",
        rowsRead: 0,
        validRows: 0,
        errorRows: 0,
        newRows: 0,
        updatedRows: 0,
        unchangedRows: 0,
        schemaChange,
      };
    }
    await appPool().query(
      `UPDATE sync_runs SET status='EXTRACTING', schema_change_json=$2::jsonb
       WHERE id=$1`,
      [syncRunId, JSON.stringify(schemaChange)],
    );
    const rows = await withSource(id, async (client) => {
      const result = await client.query(
        `SELECT * FROM ${quoteIdentifier(source.source_schema)}.${quoteIdentifier(source.source_object)}
         ORDER BY ${quoteIdentifier(source.business_key_field)}`,
      );
      return result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, sourceValue(value)]),
        ),
      );
    });
    await appPool().query(
      "UPDATE sync_runs SET status = 'VALIDATING', rows_read = $2 WHERE id = $1",
      [syncRunId, rows.length],
    );
    const mapping = source.mapping_json as {
      processConfig: ProcessConfig;
      updatedAtField: string;
    };
    const asOf = new Date().toISOString();
    const normalized = normalizeRows(rows, mapping.processConfig, asOf);
    const cursorEnd = maxCursor(
      rows,
      mapping.updatedAtField,
      mapping.processConfig.keyField,
    );
    const current =
      (await postgresStorage.getSetting<ProcessConfig>("process_config")) ??
      mapping.processConfig;
    const structureDiff = compareProcessStructure(
      current,
      mapping.processConfig,
    );
    const prepared = await postgresStorage.prepareImportBatch(
      `postgresql://${source.name}/${source.source_schema}.${source.source_object}`,
      asOf,
      rows.length,
      normalized.validRows,
      normalized.measurements,
      mapping.processConfig,
      normalized.issues,
      structureDiff,
    );
    const status =
      normalized.issues.length > 0 || structureDiff.changed
        ? "QUALITY_BLOCKED"
        : "READY_TO_PUBLISH";
    await appPool().query(
      `UPDATE sync_runs SET status = $2, import_batch_id = $3,
       rows_new = $4, rows_updated = $5, rows_unchanged = $6,
       rows_rejected = $7, cursor_end_json = $8::jsonb,
       finished_at = CASE WHEN $2 = 'QUALITY_BLOCKED' THEN now() ELSE NULL END
       WHERE id = $1`,
      [
        syncRunId,
        status,
        prepared.batchId,
        prepared.newRows,
        prepared.updatedRows,
        prepared.unchangedRows,
        normalized.issues.length,
        JSON.stringify(cursorEnd),
      ],
    );
    return {
      syncRunId,
      batchId: prepared.batchId,
      status,
      rowsRead: rows.length,
      validRows: normalized.validRows.length,
      errorRows: normalized.issues.length,
      newRows: prepared.newRows,
      updatedRows: prepared.updatedRows,
      unchangedRows: prepared.unchangedRows,
    };
  } catch (error) {
    await appPool().query(
      `UPDATE sync_runs SET status = 'FAILED', finished_at = now(),
       error_code = 'FULL_SYNC_FAILED', error_summary = $2 WHERE id = $1`,
      [
        syncRunId,
        error instanceof Error ? error.message.slice(0, 500) : "未知错误",
      ],
    );
    throw error;
  }
}

export async function publishSyncRun(syncRunId: number) {
  const claimed = await appPool().query<any>(
    `UPDATE sync_runs SET status = 'PUBLISHING'
     WHERE id = $1 AND status = 'READY_TO_PUBLISH' AND import_batch_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM data_sources ds WHERE ds.id = sync_runs.data_source_id
         AND ds.process_space_id = ${defaultProcessSpace})
     RETURNING *`,
    [syncRunId],
  );
  const run = claimed.rows[0];
  if (!run) throw new Error("当前同步任务不能发布");
  try {
    await postgresStorage.publishImportBatch(
      Number(run.import_batch_id),
      false,
      Number(run.data_source_id),
    );
    await appPool().query(
      "UPDATE sync_runs SET status = 'PUBLISHED', finished_at = now() WHERE id = $1",
      [syncRunId],
    );
    return { syncRunId, batchId: Number(run.import_batch_id), published: true };
  } catch (error) {
    await appPool().query(
      `UPDATE sync_runs SET status = 'FAILED', finished_at = now(),
       error_code = 'PUBLISH_FAILED', error_summary = $2 WHERE id = $1`,
      [
        syncRunId,
        error instanceof Error ? error.message.slice(0, 500) : "未知错误",
      ],
    );
    throw error;
  }
}

export async function runIncrementalSync(
  id: number,
  triggerType: "MANUAL" | "SCHEDULED" | "RETRY" = "MANUAL",
  attemptNo = 1,
) {
  const source = (
    await appPool().query<any>(
      `SELECT ds.*, dsmv.id AS mapping_version_id,
       dsmv.source_schema_json
       FROM data_sources ds
       JOIN data_source_mapping_versions dsmv
         ON dsmv.data_source_id = ds.id AND dsmv.version_no = ds.mapping_version
       WHERE ds.id = $1 AND ds.process_space_id = ${defaultProcessSpace}`,
      [id],
    )
  ).rows[0];
  if (!source || source.status !== "ACTIVE")
    throw new Error("只有已启用的数据源可以增量同步");
  const lastRun = (
    await appPool().query<any>(
      `SELECT cursor_end_json FROM sync_runs
       WHERE data_source_id = $1 AND status = 'PUBLISHED' AND cursor_end_json IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [id],
    )
  ).rows[0];
  if (!lastRun?.cursor_end_json?.updatedAt)
    throw new Error("尚无已发布的全量游标，请先完成首次全量同步");
  const active = await appPool().query(
    `SELECT 1 FROM sync_runs WHERE data_source_id = $1 AND status IN
     ('QUEUED','CONNECTING','EXTRACTING','VALIDATING','READY_TO_PUBLISH','PUBLISHING')`,
    [id],
  );
  if (active.rowCount) throw new Error("该数据源已有尚未完成的同步任务");
  const created = await appPool().query<{ id: string }>(
    `INSERT INTO sync_runs(data_source_id, mapping_version_id, run_type,
     trigger_type, status, started_at, cursor_start_json)
     VALUES ($1, $2, 'INCREMENTAL', $4, 'CONNECTING', now(), $3::jsonb)
     RETURNING id`,
    [
      id,
      source.mapping_version_id,
      JSON.stringify(lastRun.cursor_end_json),
      triggerType,
    ],
  );
  const syncRunId = Number(created.rows[0].id);
  await appPool().query("UPDATE sync_runs SET attempt_no=$2 WHERE id=$1", [
    syncRunId,
    attemptNo,
  ]);
  try {
    const schemaChange = await inspectSchemaDrift(id, source);
    if (schemaChange.blocking) {
      await appPool().query(
        `UPDATE sync_runs SET status='SCHEMA_BLOCKED', finished_at=now(),
         error_code='SCHEMA_DRIFT', error_summary=$2,
         schema_change_json=$3::jsonb WHERE id=$1`,
        [
          syncRunId,
          schemaDriftSummary(schemaChange),
          JSON.stringify(schemaChange),
        ],
      );
      return {
        syncRunId,
        status: "SCHEMA_BLOCKED",
        rowsRead: 0,
        newRows: 0,
        updatedRows: 0,
        unchangedRows: 0,
        errorRows: 0,
        schemaChange,
      };
    }
    await appPool().query(
      `UPDATE sync_runs SET status='EXTRACTING', schema_change_json=$2::jsonb
       WHERE id=$1`,
      [syncRunId, JSON.stringify(schemaChange)],
    );
    const mapping = source.mapping_json as {
      processConfig: ProcessConfig;
      updatedAtField: string;
    };
    const lookbackStart = new Date(
      Date.parse(lastRun.cursor_end_json.updatedAt) - 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows = await withSource(id, async (client) => {
      const result = await client.query(
        `SELECT * FROM ${quoteIdentifier(source.source_schema)}.${quoteIdentifier(source.source_object)}
         WHERE ${quoteIdentifier(mapping.updatedAtField)} >= $1
         ORDER BY ${quoteIdentifier(mapping.updatedAtField)}, ${quoteIdentifier(source.business_key_field)}`,
        [lookbackStart],
      );
      return result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, sourceValue(value)]),
        ),
      );
    });
    await appPool().query(
      "UPDATE sync_runs SET status='VALIDATING', rows_read=$2 WHERE id=$1",
      [syncRunId, rows.length],
    );
    const asOf = new Date().toISOString();
    const normalized = normalizeRows(rows, mapping.processConfig, asOf);
    const prepared = await postgresStorage.prepareImportBatch(
      `postgresql://${source.name}/${source.source_schema}.${source.source_object}#incremental`,
      asOf,
      rows.length,
      normalized.validRows,
      normalized.measurements,
      mapping.processConfig,
      normalized.issues,
      { changed: false, changes: [] },
    );
    const cursorEnd =
      maxCursor(rows, mapping.updatedAtField, mapping.processConfig.keyField) ??
      lastRun.cursor_end_json;
    const status = normalized.issues.length
      ? "QUALITY_BLOCKED"
      : "READY_TO_PUBLISH";
    await appPool().query(
      `UPDATE sync_runs SET status=$2, import_batch_id=$3, rows_new=$4,
       rows_updated=$5, rows_unchanged=$6, rows_rejected=$7,
       cursor_end_json=$8::jsonb,
       finished_at=CASE WHEN $2='QUALITY_BLOCKED' THEN now() ELSE NULL END
       WHERE id=$1`,
      [
        syncRunId,
        status,
        prepared.batchId,
        prepared.newRows,
        prepared.updatedRows,
        prepared.unchangedRows,
        normalized.issues.length,
        JSON.stringify(cursorEnd),
      ],
    );
    if (status === "QUALITY_BLOCKED")
      return {
        syncRunId,
        batchId: prepared.batchId,
        status,
        rowsRead: rows.length,
        newRows: prepared.newRows,
        updatedRows: prepared.updatedRows,
        unchangedRows: prepared.unchangedRows,
        errorRows: normalized.issues.length,
      };
    await publishSyncRun(syncRunId);
    return {
      syncRunId,
      batchId: prepared.batchId,
      status: "PUBLISHED",
      rowsRead: rows.length,
      newRows: prepared.newRows,
      updatedRows: prepared.updatedRows,
      unchangedRows: prepared.unchangedRows,
      errorRows: 0,
    };
  } catch (error) {
    await appPool().query(
      `UPDATE sync_runs SET status='FAILED', finished_at=now(),
       error_code='INCREMENTAL_SYNC_FAILED', error_summary=$2 WHERE id=$1
       AND status NOT IN ('PUBLISHED','QUALITY_BLOCKED')`,
      [
        syncRunId,
        error instanceof Error ? error.message.slice(0, 500) : "未知错误",
      ],
    );
    throw error;
  }
}

export async function retrySyncRun(id: number) {
  const run = (
    await appPool().query<any>(
      `SELECT sr.* FROM sync_runs sr JOIN data_sources ds ON ds.id = sr.data_source_id
       WHERE sr.id = $1 AND ds.process_space_id = ${defaultProcessSpace}`,
      [id],
    )
  ).rows[0];
  if (!run) throw new Error("同步批次不存在");
  if (
    !["FAILED", "QUALITY_BLOCKED", "SCHEMA_BLOCKED", "CANCELLED"].includes(
      run.status,
    )
  )
    throw new Error("只有失败、阻断或已取消的同步批次可以重试");
  const attempt = Number(run.attempt_no ?? 1) + 1;
  return run.run_type === "FULL"
    ? runFullSync(Number(run.data_source_id), "RETRY", attempt)
    : runIncrementalSync(Number(run.data_source_id), "RETRY", attempt);
}

function zonedParts(date: Date, timeZone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
}

const weekdays: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

type Schedule = {
  enabled: boolean;
  frequency: "EVERY_15_MINUTES" | "HOURLY" | "DAILY" | "WEEKLY";
  hour: number;
  minute: number;
  dayOfWeek: number;
  timezone: string;
  nextRunAt?: string | null;
};

export function nextScheduledAt(schedule: Schedule, after: Date) {
  const start = new Date(after);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  for (let offset = 0; offset <= 8 * 24 * 60; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    const parts = zonedParts(candidate, schedule.timezone);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    const matches =
      (schedule.frequency === "EVERY_15_MINUTES" && minute % 15 === 0) ||
      (schedule.frequency === "HOURLY" && minute === schedule.minute) ||
      (schedule.frequency === "DAILY" &&
        hour === schedule.hour &&
        minute === schedule.minute) ||
      (schedule.frequency === "WEEKLY" &&
        weekdays[parts.weekday] === schedule.dayOfWeek &&
        hour === schedule.hour &&
        minute === schedule.minute);
    if (matches) return candidate;
  }
  throw new Error("无法计算下次同步时间");
}

async function runScheduledWithRetry(id: number) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await runIncrementalSync(
        id,
        attempt === 1 ? "SCHEDULED" : "RETRY",
        attempt,
      );
    } catch (error) {
      lastError = error;
      if (attempt < 3)
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

export async function runDueDataSourceSchedules(now = new Date()) {
  const sources = (
    await appPool().query<any>(
      `SELECT id, schedule_json FROM data_sources
       WHERE status='ACTIVE' AND (schedule_json->>'enabled')::boolean=true
         AND process_space_id = ${defaultProcessSpace}`,
    )
  ).rows;
  const results: Array<{ id: number; result?: unknown; error?: string }> = [];
  for (const source of sources) {
    const schedule = source.schedule_json as Schedule;
    const nextRunAt = schedule.nextRunAt
      ? new Date(schedule.nextRunAt)
      : nextScheduledAt(schedule, new Date(now.getTime() - 60_000));
    if (nextRunAt > now) continue;
    try {
      results.push({
        id: Number(source.id),
        result: await runScheduledWithRetry(Number(source.id)),
      });
    } catch (error) {
      results.push({
        id: Number(source.id),
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
    schedule.nextRunAt = nextScheduledAt(schedule, now).toISOString();
    await appPool().query(
      "UPDATE data_sources SET schedule_json=$2::jsonb, updated_at=now() WHERE id=$1",
      [source.id, JSON.stringify(schedule)],
    );
  }
  return results;
}

export function startDataSourceScheduler() {
  const run = () =>
    void runDueDataSourceSchedules().catch((error) =>
      console.error("数据源定时同步检查失败", error),
    );
  const timer = setInterval(run, 60_000);
  timer.unref();
  setTimeout(run, 5_000).unref();
  return () => clearInterval(timer);
}
