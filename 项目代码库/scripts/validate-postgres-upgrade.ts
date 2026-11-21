import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Pool } from "pg";
import { DEFAULT_CONFIG } from "../packages/core/v01.js";

const databaseUrl = process.env.POSTGRES_UPGRADE_TEST_DATABASE_URL?.trim();
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("POSTGRES_UPGRADE_TEST_DATABASE_URL 必须指向名称以 _test 结尾的空库");

process.env.DATABASE_URL = databaseUrl;
process.env.ADMIN_BOOTSTRAP_TOKEN = "";

const pool = new Pool({ connectionString: databaseUrl });
try {
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(tables.rowCount, 0, "升级测试要求空数据库");

  const directory = new URL("../infra/migrations/", import.meta.url);
  const v03Files = (await readdir(directory))
    .filter((file) => /^(00[1-9]|01[01])_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  assert.equal(v03Files.length, 11);
  for (const file of v03Files)
    await pool.query(await readFile(new URL(file, directory), "utf8"));

  const password = "Upgrade-Fixture-2026";
  const salt = randomBytes(16);
  const hash = `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 64).toString("base64")}`;
  await pool.query(
    `INSERT INTO users(username, display_name, password_hash, role)
     VALUES ('upgrade-admin', '升级测试管理员', $1, 'SYSTEM_ADMIN')`,
    [hash],
  );
  await pool.query(
    `INSERT INTO settings(key, value_json) VALUES ('process_config', $1::jsonb)`,
    [JSON.stringify(DEFAULT_CONFIG)],
  );
  await pool.query(`
    WITH batch AS (
      INSERT INTO import_batches(filename, imported_at, as_of, total_rows, valid_rows, error_rows)
      VALUES ('v03-fixture.csv', now(), now(), 1, 1, 0) RETURNING id
    )
    INSERT INTO work_items(ticket_id, title, team, priority, current_status, source_json, batch_id)
    SELECT 'UPGRADE-1', '已有工作项', 'Team A', 'P1', 'released', '{"ticket_id":"UPGRADE-1"}', id FROM batch;
    INSERT INTO stage_observations(ticket_id, stage_id, stage_name, stage_type, priority, state, hours, sla_hours, overdue)
    VALUES ('UPGRADE-1', 'development', '开发', 'processing', 'P1', 'completed', 3, 4, false);
    WITH source AS (
      INSERT INTO data_sources(name, connector_type, host, database_name, username)
      VALUES ('旧版数据源', 'POSTGRESQL', '127.0.0.1', 'fixture', 'fixture') RETURNING id
    )
    INSERT INTO sync_runs(data_source_id, run_type, trigger_type, status)
    SELECT id, 'FULL', 'MANUAL', 'FAILED' FROM source;
  `);

  const { initializePostgres, closePostgres } = await import("../apps/api/src/postgres.js");
  try {
    const before = await pool.query("SELECT * FROM work_items WHERE ticket_id='UPGRADE-1'");
    const runtime = await initializePostgres();
    assert.ok(runtime.migrations.includes("012_v04_process_spaces"));
    assert.ok(runtime.migrations.includes("013_v04_data_source_space"));
    assert.deepEqual((await initializePostgres()).migrations, runtime.migrations);

    const { postgresStorage } = await import("../apps/api/src/postgres-storage.js");
    const spaces = await postgresStorage.listProcessSpaces() as Array<{ code: string; is_default: boolean }>;
    assert.deepEqual(spaces.map(({ code, is_default }) => [code, is_default]), [["default", true]]);
    assert.deepEqual((await pool.query("SELECT * FROM work_items WHERE ticket_id='UPGRADE-1'")).rows, before.rows);
    const item = await postgresStorage.getWorkItemWithObservations("UPGRADE-1");
    assert.equal(item.observations[0].sla_hours, 4);
    assert.deepEqual(await postgresStorage.getSetting("process_config"), DEFAULT_CONFIG);

    const { listDataSources, listSyncRuns } = await import("../apps/api/src/data-sources.js");
    const sources = await listDataSources();
    assert.deepEqual(sources.map(({ name, process_id }) => [name, process_id]), [["旧版数据源", "default"]]);
    assert.deepEqual((await listSyncRuns()).map(({ data_source_id }) => data_source_id), [sources[0].id]);

    const { bootstrapConfigured, needsBootstrap, login } = await import("../apps/api/src/auth.js");
    assert.equal(bootstrapConfigured, false);
    assert.equal(await needsBootstrap(), false);
    const request = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;
    assert.equal((await login("upgrade-admin", password, request))?.actor?.role, "SYSTEM_ADMIN");
  } finally {
    await closePostgres();
  }
  console.log("V0.3 到 V0.4 的 PostgreSQL 迁移、重复启动、已有数据与账号验证通过");
} finally {
  await pool.end();
}
