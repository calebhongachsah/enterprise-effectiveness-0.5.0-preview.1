import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertInsideBackups,
  dockerArgs,
  loadInfraEnv,
  query,
  run,
  sha256,
} from "./postgres-ops.js";

const requested = process.argv[2];
if (!requested || !process.argv.includes("--confirm-maintenance"))
  throw new Error(
    "用法：npm run restore:postgres -- backups/<备份编号> --confirm-maintenance",
  );
try {
  const response = await fetch(
    process.env.APP_HEALTH_URL ?? "http://127.0.0.1:8787/api/health",
    { signal: AbortSignal.timeout(1500) },
  );
  if (response.ok)
    throw new Error("平台仍在对外提供服务；请先停止应用，再执行恢复");
} catch (error) {
  if ((error as Error).message.includes("仍在对外提供服务")) throw error;
}

const target = assertInsideBackups(path.resolve(requested));
const manifest = JSON.parse(
  await readFile(path.join(target, "manifest.json"), "utf8"),
);
const { user, database } = await loadInfraEnv();
if (manifest.database !== database)
  throw new Error(
    `备份数据库为 ${manifest.database}，当前配置为 ${database}，拒绝恢复`,
  );
for (const [name, expected] of Object.entries(manifest.files)) {
  const actual = await sha256(path.join(target, name));
  if (actual !== expected) throw new Error(`备份校验失败：${name}`);
}

await run(
  "docker",
  dockerArgs("pg_restore", [
    "-U",
    user,
    "-d",
    database,
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--exit-on-error",
  ]),
  { stdinFile: path.join(target, "database.dump") },
);
await query(
  user,
  database,
  `INSERT INTO audit_events(action, object_type, object_id, result, details_json)
   VALUES ('RESTORE_COMPLETE', 'backup', '${manifest.backupId}', 'SUCCESS', '{"source":"operational-script"}'::jsonb)`,
);
const integrity = await query(
  user,
  database,
  `SELECT json_build_object(
    'schema_migrations', (SELECT count(*) FROM schema_migrations),
    'import_batches', (SELECT count(*) FROM import_batches),
    'work_items', (SELECT count(*) FROM work_items),
    'process_versions', (SELECT count(*) FROM process_versions),
    'users', (SELECT count(*) FROM users)
  )`,
);
console.log(`恢复完成：${manifest.backupId}`);
console.log(`完整性检查：${integrity}`);
