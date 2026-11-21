import { randomBytes } from "node:crypto";
import { Pool } from "pg";

export const testBootstrapToken = randomBytes(32).toString("hex");

export async function clearPostgresTestFixture(databaseUrl: string) {
  if (!decodeURIComponent(new URL(databaseUrl).pathname).endsWith("_test"))
    throw new Error("只能清理名称以 _test 结尾的专用数据库");

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      TRUNCATE settings, process_versions, import_batches, work_items, problems,
        users, data_sources, audit_events RESTART IDENTITY CASCADE;
      DELETE FROM process_spaces WHERE NOT is_default;
    `);
  } finally {
    await pool.end();
  }
}
