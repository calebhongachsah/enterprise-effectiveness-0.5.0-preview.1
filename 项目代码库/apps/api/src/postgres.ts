import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
pg.types.setTypeParser(1082, (value) => value);
const databaseUrl = process.env.DATABASE_URL?.trim();
const migrationsUrl = new URL("../../../infra/migrations/", import.meta.url);

export type PostgresRuntimeStatus =
  | { configured: false; connected: false; migrations: [] }
  | {
      configured: true;
      connected: true;
      migrations: string[];
      database: string;
    };

let pool: pg.Pool | null = null;
let runtimeStatus: PostgresRuntimeStatus = {
  configured: false,
  connected: false,
  migrations: [],
};

export function connectionPool() {
  if (!databaseUrl) return null;
  pool ??= new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.POSTGRES_POOL_SIZE ?? 10),
    connectionTimeoutMillis: Number(
      process.env.POSTGRES_CONNECT_TIMEOUT_MS ?? 5_000,
    ),
    ssl:
      process.env.POSTGRES_SSL === "require"
        ? { rejectUnauthorized: true }
        : undefined,
  });
  return pool;
}

export async function migratePostgres() {
  const currentPool = connectionPool();
  if (!currentPool)
    throw new Error("未配置 DATABASE_URL，无法执行 PostgreSQL 迁移");

  const client = await currentPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [2026100602]);
    const files = (await readdir(migrationsUrl))
      .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const migrationTable = await client.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.schema_migrations')::text AS table_name",
      );
      if (migrationTable.rows[0]?.table_name) {
        const exists = await client.query<{ applied: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1) AS applied",
          [version],
        );
        if (exists.rows[0]?.applied) continue;
      }
      await client.query(await readFile(new URL(file, migrationsUrl), "utf8"));
      const recorded = await client.query<{ applied: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1) AS applied",
        [version],
      );
      if (!recorded.rows[0]?.applied)
        throw new Error(`迁移 ${file} 执行后未登记版本`);
    }
    return files.map((file) => file.replace(/\.sql$/, ""));
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [2026100602]);
    client.release();
  }
}

export async function initializePostgres() {
  if (!databaseUrl) return runtimeStatus;
  const migrations = await migratePostgres();
  const currentPool = connectionPool();
  if (!currentPool) throw new Error("PostgreSQL 连接池初始化失败");
  const result = await currentPool.query<{ database: string }>(
    "SELECT current_database() AS database",
  );
  runtimeStatus = {
    configured: true,
    connected: true,
    migrations,
    database: result.rows[0]?.database ?? "unknown",
  };
  return runtimeStatus;
}

export function getPostgresStatus() {
  return runtimeStatus;
}

export async function closePostgres() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export const migrationsDirectory = fileURLToPath(migrationsUrl);
