import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG } from "../packages/core/v01.js";
import { clearPostgresTestFixture, testBootstrapToken } from "./postgres-test-fixture.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL?.trim();
if (!databaseUrl)
  throw new Error("未配置 POSTGRES_TEST_DATABASE_URL，拒绝运行性能测试");
if (!new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("性能测试数据库名称必须以 _test 结尾");

const pressure = process.argv.includes("--pressure");
const root = process.cwd();
const port = Number(process.env.POSTGRES_BENCHMARK_PORT ?? 9492);
const baseUrl = `http://127.0.0.1:${port}`;
const dataset = pressure
  ? "data/generated/v02-pressure-10000-utf8.csv"
  : "data/v02-simulated-pilot-1800-utf8.csv";
const expectedRows = pressure ? 10_000 : 1_800;
const reportPath = path.resolve(
  root,
  "data",
  "generated",
  pressure ? "performance-10000.json" : "performance-1800.json",
);

let cookie = "";
async function request<T>(pathname: string, body?: unknown) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.ok, true, JSON.stringify(value));
  return { value: value as T, milliseconds: performance.now() - started };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await request("/api/health");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("性能测试服务未启动");
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "apps/api/src/server.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      ADMIN_BOOTSTRAP_TOKEN: testBootstrapToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let errors = "";
child.stderr.on("data", (chunk) => (errors += String(chunk)));
const exited = once(child, "exit");
let fixtureReady = false;

try {
  await Promise.race([
    waitForServer(),
    exited.then(() => { throw new Error(`性能测试服务提前退出\n${errors}`); }),
  ]);
  await clearPostgresTestFixture(databaseUrl);
  fixtureReady = true;
  await request("/api/auth/bootstrap", {
    username: "benchmark-admin",
    displayName: "性能测试管理员",
    password: "Benchmark-Admin-2026",
    token: testBootstrapToken,
  });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "benchmark-admin",
      password: "Benchmark-Admin-2026",
    }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const csv = await readFile(path.join(root, dataset), "utf8");
  const prepare = await request<any>("/api/import/prepare", {
    filename: path.basename(dataset),
    csv,
    config: DEFAULT_CONFIG,
  });
  assert.equal(prepare.value.newRows, expectedRows);
  const publish = await request<any>(
    `/api/import-batches/${prepare.value.batchId}/publish`,
    {},
  );
  const state = await request<any>("/api/state");
  assert.equal(state.value.dashboard.summary.ticketCount, expectedRows);
  const simulatedState = await request<any>("/api/state?slaMode=current");
  assert.equal(
    simulatedState.value.dashboard.calculationMode,
    "current-config-simulation",
  );
  const repeated = await request<any>("/api/import/prepare", {
    filename: `${path.basename(dataset, ".csv")}-repeat.csv`,
    csv,
    config: DEFAULT_CONFIG,
  });
  assert.equal(repeated.value.newRows, 0);
  assert.equal(repeated.value.updatedRows, 0);
  assert.equal(repeated.value.unchangedRows, expectedRows);

  const memory = process.memoryUsage();
  const report = {
    generatedAt: new Date().toISOString(),
    storage: "postgresql",
    database: new URL(databaseUrl).pathname.slice(1),
    dataset,
    rows: expectedRows,
    observations: expectedRows * DEFAULT_CONFIG.stages.length,
    milliseconds: {
      prepare: Math.round(prepare.milliseconds),
      publish: Math.round(publish.milliseconds),
      dashboardHistorical: Math.round(state.milliseconds),
      dashboardSimulation: Math.round(simulatedState.milliseconds),
      repeatPrepare: Math.round(repeated.milliseconds),
    },
    runnerMemoryMb: {
      rss: Math.round(memory.rss / 1_048_576),
      heapUsed: Math.round(memory.heapUsed / 1_048_576),
    },
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  child.kill("SIGTERM");
  await exited;
  if (errors.trim()) console.error(errors.trim());
  if (fixtureReady) await clearPostgresTestFixture(databaseUrl);
}
