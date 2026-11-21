import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const migrationsUrl = new URL("../infra/migrations/", import.meta.url);
const sqliteSourceUrl = new URL("../apps/api/src/db.ts", import.meta.url);
const files = (await readdir(migrationsUrl))
  .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
  .sort();

assert.ok(files.length > 0, "至少需要一个 PostgreSQL 迁移文件");
assert.equal(
  new Set(files.map((file) => file.slice(0, 3))).size,
  files.length,
  "迁移编号不能重复",
);

const combined = [];
for (const file of files) {
  const sql = await readFile(new URL(file, migrationsUrl), "utf8");
  assert.match(sql, /^BEGIN;/m, `${file} 必须在事务中执行`);
  assert.match(sql, /COMMIT;\s*$/m, `${file} 必须显式提交事务`);
  assert.match(
    sql,
    /INSERT INTO schema_migrations/,
    `${file} 必须登记迁移版本`,
  );
  combined.push(sql);
}

const sqliteSource = await readFile(sqliteSourceUrl, "utf8");
const sqliteTables = [
  ...sqliteSource.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g),
].map((match) => match[1]);
assert.ok(sqliteTables.length > 0, "无法从 SQLite 数据层识别业务表");

for (const table of sqliteTables) {
  assert.match(
    combined.join("\n"),
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
    `缺少表：${table}`,
  );
}

console.log(
  `PostgreSQL 迁移静态校验通过：${files.join(", ")}；已覆盖 ${sqliteTables.length} 张现有业务表`,
);
