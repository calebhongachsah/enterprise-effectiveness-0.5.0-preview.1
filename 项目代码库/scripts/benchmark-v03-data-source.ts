import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { DEFAULT_CONFIG } from "../packages/core/v01.js";

const appUrl = process.env.POSTGRES_TEST_DATABASE_URL?.trim();
const sourceAdminUrl = process.env.SOURCE_TEST_DATABASE_URL?.trim();
const sourcePassword = process.env.SOURCE_TEST_PASSWORD?.trim();
if (!appUrl || !sourceAdminUrl || !sourcePassword)
  throw new Error(
    "缺少 POSTGRES_TEST_DATABASE_URL、SOURCE_TEST_DATABASE_URL 或 SOURCE_TEST_PASSWORD",
  );
for (const value of [appUrl, sourceAdminUrl])
  if (!new URL(value).pathname.endsWith("_test"))
    throw new Error("性能测试数据库名称必须以 _test 结尾");
if (!process.env.DATA_SOURCE_MASTER_KEY)
  throw new Error("缺少 DATA_SOURCE_MASTER_KEY");

process.env.DATABASE_URL = appUrl;
const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.resolve(
  root,
  "data",
  "generated",
  "performance-100000.json",
);
const sourceUrl = new URL(sourceAdminUrl);
const sourcePool = new Pool({ connectionString: sourceAdminUrl });

function elapsed(started: number) {
  return Math.round(performance.now() - started);
}

async function prepareSource() {
  await sourcePool.query(`
    DROP VIEW IF EXISTS effectiveness_workflow_view;
    DROP TABLE IF EXISTS customer_workflow_events;
    CREATE TABLE customer_workflow_events (
      ticket_id text PRIMARY KEY,
      title text NOT NULL,
      team text NOT NULL,
      priority text NOT NULL,
      current_status text NOT NULL,
      demand_started_at timestamptz,
      demand_ended_at timestamptz,
      development_started_at timestamptz,
      development_ended_at timestamptz,
      test_started_at timestamptz,
      test_ended_at timestamptz,
      release_started_at timestamptz,
      release_ended_at timestamptz,
      release_result text,
      updated_at timestamptz NOT NULL
    );
    INSERT INTO customer_workflow_events
    SELECT
      'PERF-' || lpad(g::text, 6, '0'),
      '性能验收事项 ' || g,
      '团队' || ((g - 1) % 8 + 1),
      CASE WHEN g % 10 = 0 THEN 'P0' WHEN g % 3 = 0 THEN 'P2' ELSE 'P1' END,
      'released',
      base_at,
      base_at + interval '6 hours',
      base_at + interval '10 hours',
      base_at + interval '30 hours',
      base_at + interval '34 hours',
      base_at + interval '46 hours',
      base_at + interval '50 hours',
      base_at + interval '54 hours',
      CASE WHEN g % 20 = 0 THEN 'failed' ELSE 'success' END,
      now() - interval '365 days' + (g * interval '365 days' / 100000)
    FROM (
      SELECT g, now() - interval '500 days' + (g % 365) * interval '1 day' AS base_at
      FROM generate_series(1, 100000) AS g
    ) generated;
    CREATE VIEW effectiveness_workflow_view AS
    SELECT ticket_id,title,team,priority,current_status,release_result,
      demand_started_at AS requirements_started_at,
      demand_ended_at AS requirements_ended_at,
      demand_ended_at AS wait_design_started_at,
      demand_ended_at + interval '1 hour' AS wait_design_ended_at,
      demand_ended_at + interval '1 hour' AS design_started_at,
      development_started_at AS design_ended_at,
      development_started_at AS wait_development_started_at,
      development_started_at AS wait_development_ended_at,
      development_started_at,
      development_ended_at,
      development_ended_at AS wait_testing_started_at,
      test_started_at AS wait_testing_ended_at,
      test_started_at AS testing_started_at,
      test_ended_at AS testing_ended_at,
      test_ended_at AS wait_release_started_at,
      release_started_at AS wait_release_ended_at,
      release_started_at,
      release_ended_at,
      updated_at
    FROM customer_workflow_events;
    GRANT SELECT ON effectiveness_workflow_view TO effectiveness_source_ro;
  `);
}

async function prepareIncrementalChanges() {
  await sourcePool.query(`
    UPDATE customer_workflow_events
    SET title = title || ' 已更新', updated_at = now()
    WHERE ticket_id BETWEEN 'PERF-000001' AND 'PERF-001000';
    INSERT INTO customer_workflow_events
    SELECT
      'PERF-' || lpad(g::text, 6, '0'),
      '性能验收新增事项 ' || g,
      '团队' || ((g - 1) % 8 + 1),
      'P1','released',base_at,base_at + interval '6 hours',
      base_at + interval '10 hours',base_at + interval '30 hours',
      base_at + interval '34 hours',base_at + interval '46 hours',
      base_at + interval '50 hours',base_at + interval '54 hours','success',now()
    FROM (
      SELECT g, now() - interval '30 days' + (g % 20) * interval '1 day' AS base_at
      FROM generate_series(100001, 101000) AS g
    ) generated;
  `);
}

await prepareSource();
const { migratePostgres, connectionPool, closePostgres } =
  await import("../apps/api/src/postgres.js");
await migratePostgres();
const {
  createDataSource,
  configureDataSource,
  runFullSync,
  publishSyncRun,
  runIncrementalSync,
} = await import("../apps/api/src/data-sources.js");

const sourceId = await createDataSource({
  name: "V0.3 10万条性能源库",
  host: sourceUrl.hostname,
  port: Number(sourceUrl.port || 5432),
  databaseName: sourceUrl.pathname.slice(1),
  username: "effectiveness_source_ro",
  password: sourcePassword,
  sslMode: "DISABLE",
});
await configureDataSource(sourceId, {
  schemaName: "public",
  objectName: "effectiveness_workflow_view",
  updatedAtField: "updated_at",
  config: DEFAULT_CONFIG,
});

let started = performance.now();
const full = await runFullSync(sourceId);
const fullMilliseconds = elapsed(started);
assert.equal(full.status, "READY_TO_PUBLISH");
assert.equal(full.validRows, 100000);

started = performance.now();
await publishSyncRun(full.syncRunId);
const publishMilliseconds = elapsed(started);
const appPool = connectionPool();
if (!appPool) throw new Error("测试业务库未初始化");
const fullCount = await appPool.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM work_items WHERE data_source_id=$1",
  [sourceId],
);
assert.equal(Number(fullCount.rows[0].count), 100000);

await prepareIncrementalChanges();
started = performance.now();
const incremental = await runIncrementalSync(sourceId);
const incrementalMilliseconds = elapsed(started);
assert.equal(incremental.status, "PUBLISHED");
assert.equal(incremental.newRows, 1000);
assert.equal(incremental.updatedRows, 1000);
const finalCount = await appPool.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM work_items WHERE data_source_id=$1",
  [sourceId],
);
assert.equal(Number(finalCount.rows[0].count), 101000);

const appSize = await appPool.query<{ bytes: string }>(
  "SELECT pg_database_size(current_database())::text AS bytes",
);
const sourceSize = await sourcePool.query<{ bytes: string }>(
  "SELECT pg_database_size(current_database())::text AS bytes",
);
const memory = process.memoryUsage();
const report = {
  generatedAt: new Date().toISOString(),
  path: "隔离 PostgreSQL 客户源库 → 平台数仓 → 已发布看板数据",
  full: {
    sourceRows: 100000,
    observations: 900000,
    milliseconds: fullMilliseconds,
    rowsPerSecond: Math.round(100000 / (fullMilliseconds / 1000)),
    publishMilliseconds,
  },
  incremental: {
    rowsRead: incremental.rowsRead,
    rowsNew: incremental.newRows,
    rowsUpdated: incremental.updatedRows,
    rowsUnchanged: incremental.unchangedRows,
    milliseconds: incrementalMilliseconds,
  },
  finalWarehouseRows: Number(finalCount.rows[0].count),
  databaseSizeMb: {
    warehouse: Math.round(Number(appSize.rows[0].bytes) / 1_048_576),
    source: Math.round(Number(sourceSize.rows[0].bytes) / 1_048_576),
  },
  runnerMemoryMb: {
    rss: Math.round(memory.rss / 1_048_576),
    heapUsed: Math.round(memory.heapUsed / 1_048_576),
    maxRss: Math.round(process.resourceUsage().maxRSS / 1024),
  },
};
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
await sourcePool.end();
await closePostgres();
