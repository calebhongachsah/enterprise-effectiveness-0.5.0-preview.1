import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  backupsRoot,
  composeFile,
  dockerArgs,
  infraDir,
  loadInfraEnv,
  query,
  run,
  sha256,
} from "./postgres-ops.js";

const { user, database } = await loadInfraEnv();
const now = new Date();
const backupId = now.toISOString().replace(/[:.]/g, "-");
const target = path.join(backupsRoot, backupId);
const configDir = path.join(target, "deployment-config");
const dumpFile = path.join(target, "database.dump");
await mkdir(configDir, { recursive: true });

try {
  await query(
    user,
    database,
    `INSERT INTO audit_events(action, object_type, object_id, result, details_json)
     VALUES ('BACKUP_CREATE', 'backup', '${backupId}', 'SUCCESS', '{"source":"operational-script"}'::jsonb)`,
  );
  await run(
    "docker",
    dockerArgs("pg_dump", [
      "-U",
      user,
      "-d",
      database,
      "-Fc",
      "--no-owner",
      "--no-privileges",
    ]),
    { stdoutFile: dumpFile },
  );

  await cp(composeFile, path.join(configDir, "docker-compose.yml"));
  await cp(
    path.join(infraDir, ".env.example"),
    path.join(configDir, ".env.example"),
  );
  await cp(
    path.join(infraDir, "migrations"),
    path.join(configDir, "migrations"),
    {
      recursive: true,
    },
  );
  const migrationFiles = (
    await readdir(path.join(configDir, "migrations"))
  ).sort();
  const files = [
    "database.dump",
    "deployment-config/docker-compose.yml",
    "deployment-config/.env.example",
    ...migrationFiles.map((name) => `deployment-config/migrations/${name}`),
  ];
  const checksums = Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [name, await sha256(path.join(target, name))]),
    ),
  );
  const counts = await query(
    user,
    database,
    `SELECT json_build_object(
    'import_batches', (SELECT count(*) FROM import_batches),
    'work_items', (SELECT count(*) FROM work_items),
    'process_versions', (SELECT count(*) FROM process_versions),
    'users', (SELECT count(*) FROM users),
    'audit_events', (SELECT count(*) FROM audit_events)
  )`,
  );
  await writeFile(
    path.join(target, "manifest.json"),
    `${JSON.stringify(
      {
        formatVersion: 1,
        backupId,
        createdAt: now.toISOString(),
        database,
        databaseEngine: "PostgreSQL 17",
        counts: JSON.parse(counts),
        files: checksums,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const retention = Number(process.env.BACKUP_RETENTION_COUNT ?? 14);
  if (!Number.isInteger(retention) || retention < 1)
    throw new Error("BACKUP_RETENTION_COUNT 必须是大于 0 的整数");
  const backupDirectories = (
    await readdir(backupsRoot, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const expired of backupDirectories.slice(retention))
    await rm(path.join(backupsRoot, expired), { recursive: true, force: true });
  console.log(`备份完成：${target}`);
} catch (error) {
  await query(
    user,
    database,
    `INSERT INTO audit_events(action, object_type, object_id, result, details_json)
     VALUES ('BACKUP_CREATE', 'backup', '${backupId}', 'FAILED', '{"source":"operational-script"}'::jsonb)`,
  ).catch(() => undefined);
  throw error;
}
