import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const projectRoot = path.resolve(import.meta.dirname, "..");
export const infraDir = path.join(projectRoot, "infra");
export const composeFile = path.join(infraDir, "docker-compose.yml");
export const envFile = path.join(infraDir, ".env");
export const backupsRoot = path.join(projectRoot, "backups");

export async function loadInfraEnv() {
  const source = await readFile(envFile, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
  const user = process.env.POSTGRES_USER?.trim();
  const database = process.env.POSTGRES_DB?.trim();
  if (!user || !database)
    throw new Error("infra/.env 必须配置 POSTGRES_USER 和 POSTGRES_DB");
  return { user, database };
}

export function dockerArgs(command: string, args: string[]) {
  return [
    "compose",
    "--env-file",
    envFile,
    "-f",
    composeFile,
    "exec",
    "-T",
    "postgres",
    command,
    ...args,
  ];
}

export function run(
  command: string,
  args: string[],
  options: { stdoutFile?: string; stdinFile?: string; capture?: boolean } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: [
        options.stdinFile ? "pipe" : "ignore",
        options.stdoutFile || options.capture ? "pipe" : "inherit",
        "pipe",
      ],
    });
    let output = "";
    let errors = "";
    if (options.stdinFile)
      createReadStream(options.stdinFile).pipe(child.stdin!);
    if (options.stdoutFile)
      child.stdout!.pipe(createWriteStream(options.stdoutFile));
    else if (options.capture)
      child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (errors += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else
        reject(new Error(`${command} 执行失败（${code}）\n${errors.trim()}`));
    });
  });
}

export async function sha256(file: string) {
  await access(file);
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function query(user: string, database: string, sql: string) {
  return run(
    "docker",
    dockerArgs("psql", ["-U", user, "-d", database, "-Atc", sql]),
    { capture: true },
  );
}

export function assertInsideBackups(target: string) {
  const resolved = path.resolve(target);
  const relative = path.relative(backupsRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("恢复目标必须是 backups/ 下的一个具体备份目录");
  return resolved;
}
