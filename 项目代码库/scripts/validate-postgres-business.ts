import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { Pool } from "pg";
import { DEFAULT_CONFIG, parseCsv } from "../packages/core/v01.js";
import { clearPostgresTestFixture, testBootstrapToken } from "./postgres-test-fixture.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL?.trim();
if (!databaseUrl)
  throw new Error("未配置 POSTGRES_TEST_DATABASE_URL，拒绝运行真实数据库测试");
if (!new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error(
    "POSTGRES_TEST_DATABASE_URL 必须指向名称以 _test 结尾的专用数据库",
  );
const root = process.cwd();
const port = Number(process.env.POSTGRES_TEST_PORT ?? 9491);
const baseUrl = `http://127.0.0.1:${port}`;

let adminCookie = "";
async function request<T>(
  pathname: string,
  body?: unknown,
  cookie = adminCookie,
  expectedStatus?: number,
): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (expectedStatus === undefined)
    assert.equal(response.ok, true, JSON.stringify(value));
  else assert.equal(response.status, expectedStatus, JSON.stringify(value));
  return value as T;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await request<any>("/api/health");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("PostgreSQL 测试服务未启动");
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
      DATA_SOURCE_MASTER_KEY: randomBytes(32).toString("base64"),
      SESSION_COOKIE_SECURE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let errors = "";
child.stderr.on("data", (chunk) => (errors += String(chunk)));
const exited = once(child, "exit");
let fixtureReady = false;

try {
  const health = await Promise.race([
    waitForServer(),
    exited.then(() => { throw new Error(`PostgreSQL 测试服务提前退出\n${errors}`); }),
  ]);
  assert.equal(health.storage, "postgresql");
  assert.equal(health.postgres.connected, true);
  assert.ok(health.postgres.migrations.includes("012_v04_process_spaces"));
  assert.ok(health.postgres.migrations.includes("013_v04_data_source_space"));
  await clearPostgresTestFixture(databaseUrl);
  fixtureReady = true;
  const authStatus = await request<any>("/api/auth/status", undefined, "");
  assert.equal(authStatus.needsBootstrap, true);
  const admin = { username: "admin", displayName: "测试管理员", password: "Postgres-Test-2026" };
  await request("/api/auth/bootstrap", admin, "", 403);
  const bootstrap = { ...admin, token: testBootstrapToken };
  await request("/api/auth/bootstrap", { ...bootstrap, password: "short" }, "", 400);
  await request("/api/auth/bootstrap", bootstrap, "", 201);
  await request("/api/auth/bootstrap", bootstrap, "", 409);
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Postgres-Test-2026" }),
  });
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get("set-cookie") ?? "", /; Secure/);
  adminCookie = loginResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.ok(adminCookie);
  await request("/api/reset", { confirm: "RESET_DEMO" }, adminCookie, 403);

  const space = await request<{ id: number }>("/api/process-spaces", {
    name: "第二流程", code: "second-flow", owner: "验证负责人",
  }, adminCookie, 201);
  await request(`/api/process-spaces/${space.id}/status`, { status: "INACTIVE" });
  await request(`/api/process-spaces/${space.id}/status`, { status: "ACTIVE" });
  const source = await request<{ id: number }>("/api/data-sources", {
    name: "测试连接", host: "127.0.0.1", databaseName: "fixture", username: "fixture",
    password: "Fixture-Only-2026", sslMode: "DISABLE",
  }, adminCookie, 201);
  const scopeFixture = new Pool({ connectionString: databaseUrl });
  try {
    const otherSource = await scopeFixture.query<{ id: string }>(
      `INSERT INTO data_sources(process_space_id, name, connector_type, host, database_name, username)
       VALUES ($1, '测试连接', 'POSTGRESQL', '127.0.0.1', 'fixture', 'fixture') RETURNING id`,
      [space.id],
    );
    const run = await scopeFixture.query<{ id: string }>(
      `INSERT INTO sync_runs(data_source_id, run_type, trigger_type, status)
       VALUES ($1, 'FULL', 'MANUAL', 'FAILED'), ($2, 'FULL', 'MANUAL', 'FAILED') RETURNING id`,
      [source.id, otherSource.rows[0].id],
    );
    const listedSources = (await request<any>("/api/data-sources")).dataSources;
    assert.deepEqual(listedSources.map((item: any) => [Number(item.id), item.process_id]), [[source.id, "default"]]);
    const listedRuns = (await request<any>("/api/sync-runs")).syncRuns;
    assert.deepEqual(listedRuns.map((item: any) => item.id), [run.rows[0].id]);
    assert.deepEqual((await request<any>(`/api/sync-runs?dataSourceId=${otherSource.rows[0].id}`)).syncRuns, []);
    assert.equal((await request<any>(`/api/sync-runs/${run.rows[0].id}`)).run.id, run.rows[0].id);
    await request(`/api/sync-runs/${run.rows[1].id}`, undefined, adminCookie, 404);
  } finally {
    await scopeFixture.end();
  }

  const csv = await readFile(
    path.join(root, "data", "software-development-demo-utf8.csv"),
    "utf8",
  );
  const initial = await request<any>("/api/import/prepare", {
    filename: "postgres-initial.csv",
    csv: Papa.unparse([
      ...parseCsv(csv).rows,
      { ...parseCsv(csv).rows[0], ticket_id: "" },
    ]),
    config: DEFAULT_CONFIG,
  });
  assert.equal(initial.newRows, 48);
  await request(`/api/import-batches/${initial.batchId}/publish`, {});
  assert.equal((await request<any>("/api/state")).dashboard.summary.dataValidRate, 48 / 49);
  const repeated = await request<any>("/api/import/prepare", {
    filename: "postgres-initial-repeat.csv",
    csv,
    config: DEFAULT_CONFIG,
  });
  assert.equal(repeated.newRows, 0);
  assert.equal(repeated.updatedRows, 0);
  assert.equal(repeated.unchangedRows, 48);

  const parsedForCorrection = parseCsv(csv);
  const correctionSource = parsedForCorrection.rows[0];
  const invalidCsv = Papa.unparse([{ ...correctionSource, ticket_id: "" }]);
  const invalidBatch = await request<any>(
    "/api/import/prepare",
    {
      filename: "postgres-one-invalid-row.csv",
      csv: invalidCsv,
      config: DEFAULT_CONFIG,
    },
    adminCookie,
    400,
  );
  assert.equal(invalidBatch.issues.length, 1);
  assert.equal(invalidBatch.issues[0].code, "missing_ticket_id");
  const correctedCsv = Papa.unparse([
    {
      ...correctionSource,
      ticket_id: "PG-CORRECTED-ROW",
      title: "错误修正后的事项",
    },
  ]);
  const correctedBatch = await request<any>("/api/import/prepare", {
    filename: "postgres-one-corrected-row.csv",
    csv: correctedCsv,
    config: DEFAULT_CONFIG,
  });
  assert.equal(correctedBatch.errorRows, 0);
  assert.equal(correctedBatch.newRows, 1);
  await request(`/api/import-batches/${correctedBatch.batchId}/publish`, {});
  const correctedItem = await request<any>("/api/work-items/PG-CORRECTED-ROW");
  assert.equal(correctedItem.title, "错误修正后的事项");

  const teamConfig = structuredClone(DEFAULT_CONFIG);
  teamConfig.teamSlaHours = {
    "Team A": { wait_development: { P1: 6 } },
  };
  const draft = await request<any>("/api/process-versions/drafts", {
    config: teamConfig,
    baselines: {
      releaseSuccessTarget: 0.9,
      slaAchievementTarget: { P0: 1, P1: 0.8, P2: 0.8 },
    },
    changeNote: "PostgreSQL Team A SLA 验证",
  });
  await request(`/api/process-versions/${draft.id}/publish`, {});

  const parsed = parseCsv(csv);
  const sourceA = parsed.rows.find(
    (row) => row.team === "Team A" && row.priority === "P1",
  )!;
  const sourceB = parsed.rows.find(
    (row) => row.team === "Team B" && row.priority === "P1",
  )!;
  const incrementalCsv = Papa.unparse([
    { ...sourceA, ticket_id: "PG-TEAM-A-NEW", title: "PG Team A" },
    { ...sourceB, ticket_id: "PG-TEAM-B-NEW", title: "PG Team B" },
  ]);
  const incremental = await request<any>("/api/import/prepare", {
    filename: "postgres-increment.csv",
    csv: incrementalCsv,
    config: teamConfig,
  });
  assert.equal(incremental.newRows, 2);
  await request(`/api/import-batches/${incremental.batchId}/publish`, {});

  const [itemA, itemB, state] = await Promise.all([
    request<any>("/api/work-items/PG-TEAM-A-NEW"),
    request<any>("/api/work-items/PG-TEAM-B-NEW"),
    request<any>("/api/state?priority=P1"),
  ]);
  const sla = (item: any) =>
    Number(
      item.observations.find(
        (observation: any) => observation.stage_id === "wait_development",
      ).sla_hours,
    );
  assert.equal(sla(itemA), 6);
  assert.equal(sla(itemB), 12);

  await request("/api/operational-reasons", {
    ticketId: "PG-TEAM-A-NEW",
    stageId: "wait_development",
    kind: "delay",
    category: "依赖与协作",
    detail: "PostgreSQL 原因记录验证",
    responsibleTeam: "Team A",
    owner: "原因负责人",
    dueDate: "2026-10-20",
  });
  await request("/api/operational-reasons", {
    ticketId: "PG-TEAM-B-NEW",
    stageId: "wait_development",
    kind: "delay",
    category: "",
    detail: "",
    responsibleTeam: "Team B",
    owner: "待填写负责人",
    dueDate: "2026-10-15",
  });
  const problem = await request<any>("/api/problems", {
    title: "PostgreSQL 持续改进验证",
    impact: "降低等待开发时长",
    owner: "测试负责人",
    team: "Team A",
  });
  await request(
    `/api/problems/${problem.id}/status`,
    { status: "已完成" },
    adminCookie,
    409,
  );
  await request(
    `/api/problems/${problem.id}/status`,
    { status: "进行中" },
    adminCookie,
    400,
  );
  await request(`/api/problems/${problem.id}/status`, {
    status: "进行中",
    dueDate: "2026-10-31",
  });
  await request(`/api/problems/${problem.id}/status`, { status: "已完成" });
  await request(`/api/problems/${problem.id}`, {
    title: "PostgreSQL 持续改进验证（已编辑）",
    impact: "降低等待开发时长",
    owner: "新负责人",
    team: "Team A",
    dueDate: "2026-11-15",
  });
  const teamBProblem = await request<any>("/api/problems", {
    title: "Team B 改进项",
    impact: "验证团队隔离",
    owner: "Team B 负责人",
    team: "Team B",
  });
  const finalState = await request<any>("/api/state?priority=P1");
  assert.equal(finalState.importBatches.length, 4);
  assert.equal(finalState.processVersions.length, 2);
  assert.equal(finalState.problems[0].ticketIds.length, 0);
  assert.equal(
    finalState.problems.find((item: any) => Number(item.id) === problem.id)
      .status,
    "已完成",
  );
  assert.equal(
    finalState.problems.find((item: any) => Number(item.id) === problem.id)
      .due_date,
    "2026-11-15",
  );
  assert.equal(finalState.operations.reasons.length, 2);
  assert.equal(
    finalState.operations.reasons.find(
      (reason: any) => reason.ticket_id === "PG-TEAM-A-NEW",
    ).status,
    "已填写",
  );
  assert.equal(
    finalState.operations.reasons.find(
      (reason: any) => reason.ticket_id === "PG-TEAM-B-NEW",
    ).status,
    "待填写",
  );
  assert.equal(
    finalState.dashboard.teamMatrix
      .find((row: any) => row.team === "Team A")
      .stages.find((stage: any) => stage.id === "wait_development")
      .comparisonSlaHours,
    6,
  );
  const renamedConfig = structuredClone(teamConfig);
  renamedConfig.stages[0].name = "需求澄清";
  const structureCsv = Papa.unparse([
    { ...sourceA, title: "结构覆盖后的标题" },
  ]);
  const conflict = await request<any>("/api/import/prepare", {
    filename: "postgres-structure-conflict.csv",
    csv: structureCsv,
    config: renamedConfig,
  });
  assert.equal(conflict.structureDiff.changed, true);
  await request(
    `/api/import-batches/${conflict.batchId}/publish`,
    {},
    adminCookie,
    409,
  );
  await request(`/api/import-batches/${conflict.batchId}/reject`, {});

  const override = await request<any>("/api/import/prepare", {
    filename: "postgres-structure-override.csv",
    csv: structureCsv,
    config: renamedConfig,
  });
  await request(`/api/import-batches/${override.batchId}/publish`, {
    confirmStructureOverride: "OVERWRITE_PROCESS",
  });
  const historyCheck = new Pool({ connectionString: databaseUrl });
  try {
    const history = await historyCheck.query<{
      is_current: boolean;
      count: string;
    }>(
      `SELECT is_current, count(*)::text AS count FROM stage_observations
       WHERE ticket_id=$1 GROUP BY is_current ORDER BY is_current`,
      [sourceA.ticket_id],
    );
    assert.ok(
      history.rows.some((row) => !row.is_current && Number(row.count) > 0),
    );
    assert.ok(
      history.rows.some((row) => row.is_current && Number(row.count) > 0),
    );
  } finally {
    await historyCheck.end();
  }
  const teamLeadUsername = `teamlead_${Date.now()}`;
  await request(
    "/api/users",
    {
      username: teamLeadUsername,
      displayName: "Team A 负责人",
      password: "Team-Lead-2026",
      role: "TEAM_LEAD",
      teams: ["Team A"],
    },
    adminCookie,
    201,
  );
  const teamLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: teamLeadUsername,
      password: "Team-Lead-2026",
    }),
  });
  assert.equal(teamLogin.status, 200);
  const teamCookie = teamLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  const forcedChange = await request<any>(
    "/api/state",
    undefined,
    teamCookie,
    403,
  );
  assert.equal(forcedChange.code, "PASSWORD_CHANGE_REQUIRED");
  await request(
    "/api/auth/change-password",
    { currentPassword: "Team-Lead-2026", newPassword: "Team-Lead-New-2026" },
    teamCookie,
  );
  const teamState = await request<any>("/api/state", undefined, teamCookie);
  assert.deepEqual(teamState.dashboard.teams, ["Team A"]);
  assert.deepEqual(Object.keys(teamState.dashboard.lastImport), ["imported_at"]);
  assert.equal(teamState.dashboard.summary.dataValidRate, null);
  assert.ok(
    teamState.dashboard.teamMatrix.every((row: any) => row.team === "Team A"),
  );
  assert.deepEqual(
    teamState.problems.map((item: any) => item.team),
    ["Team A"],
  );
  const savedReason = await request<any>("/api/operational-reasons", {
    ticketId: "PG-TEAM-A-NEW",
    stageId: "wait_development",
    kind: "delay",
    category: "排队",
    detail: "仅限 Team A 的原因",
    responsibleTeam: "Team A",
    owner: "Team A 负责人",
    dueDate: "2026-11-30",
  }, teamCookie, 201);
  assert.deepEqual([...new Set(savedReason.reasons.map((reason: any) => reason.ticket_id))], ["PG-TEAM-A-NEW"]);
  const problemDetails = {
    title: "Team A 改进项", impact: "缩短等待时间", owner: "Team A 负责人", team: "Team A",
  };
  const created = await request<any>("/api/problems", problemDetails, teamCookie, 201);
  const revised = await request<any>(`/api/problems/${created.id}`, problemDetails, teamCookie);
  const advanced = await request<any>(`/api/problems/${created.id}/status`, {
    status: "进行中", dueDate: "2026-11-30",
  }, teamCookie);
  for (const response of [created, revised, advanced]) {
    assert.ok(response.problems.length > 0);
    assert.ok(response.problems.every((problem: any) => problem.team === "Team A"));
  }
  await request(`/api/problems/${teamBProblem.id}/actions/1/status`, { status: "已完成" }, teamCookie, 403);
  await request(
    `/api/problems/${teamBProblem.id}/status`,
    { status: "进行中", dueDate: "2026-11-30" },
    teamCookie,
    403,
  );
  const forbidden = await request<any>(
    "/api/operational-reasons",
    {
      ticketId: "PG-TEAM-B-NEW",
      stageId: "wait_development",
      kind: "delay",
      category: "越权测试",
      detail: "不应写入",
      responsibleTeam: "Team B",
      owner: "越权负责人",
      dueDate: "2026-10-20",
    },
    teamCookie,
    403,
  );
  assert.match(forbidden.message, /未授权团队/);
  await request("/api/audit-events", undefined, teamCookie, 403);
  const auditLog = await request<any>("/api/audit-events");
  assert.ok(auditLog.events.some((event: any) => event.action === "PROCESS_SPACE_CREATE" && event.result === "SUCCESS"));
  assert.equal(auditLog.events.filter((event: any) => event.action === "PROCESS_SPACE_STATUS_UPDATE" && event.result === "SUCCESS").length, 2);
  assert.ok(
    auditLog.events.some(
      (event: any) =>
        event.action === "OPERATIONAL_REASON_SAVE" && event.result === "DENIED",
    ),
  );
  assert.ok(
    auditLog.events.some(
      (event: any) =>
        event.action === "AUDIT_READ" && event.result === "DENIED",
    ),
  );
  const teamUser = (await request<any>("/api/users")).users.find(
    (user: any) => user.username === teamLeadUsername,
  );
  await request(`/api/users/${teamUser.id}/reset-password`, {
    password: "Team-Lead-Reset-2026",
  });
  await request("/api/auth/me", undefined, teamCookie, 401);
  const resetLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: teamLeadUsername,
      password: "Team-Lead-Reset-2026",
    }),
  });
  assert.equal(resetLogin.status, 200);
  const resetCookie = resetLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  await request("/api/state", undefined, resetCookie, 403);
  await request(
    "/api/auth/change-password",
    {
      currentPassword: "Team-Lead-Reset-2026",
      newPassword: "Team-Lead-Final-2026",
    },
    resetCookie,
  );
  await request(`/api/users/${teamUser.id}/active`, { active: false });
  await request("/api/auth/me", undefined, resetCookie, 401);
  await request(`/api/users/${teamUser.id}/active`, { active: true });
  await request("/api/reset", { confirm: "RESET_DEMO" }, adminCookie, 403);
  assert.ok((await request<any>("/api/state")).dashboard.summary.ticketCount > 0);
  console.log("PostgreSQL 业务存储真实数据库测试通过");
} finally {
  child.kill("SIGTERM");
  await exited;
  if (errors.trim()) console.error(errors.trim());
  if (fixtureReady) await clearPostgresTestFixture(databaseUrl);
}
