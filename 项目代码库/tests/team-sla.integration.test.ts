import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { DEFAULT_CONFIG, parseCsv } from "../packages/core/v01.js";

const root = process.cwd();
const port = 9_000 + (process.pid % 500);
const databasePath = path.join(
  root,
  "data",
  `.team-sla-integration-${process.pid}.sqlite`,
);
const baseUrl = `http://127.0.0.1:${port}`;

async function request<T>(pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.ok, true, JSON.stringify(value));
  return value as T;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await request("/api/health");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("隔离测试服务未在预期时间内启动");
}

test("团队 SLA 从配置版本进入新观测，且不改写旧观测", async () => {
  await rm(databasePath, { force: true });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/src/server.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        SQLITE_DATABASE_PATH: databasePath,
        DATABASE_URL: "",
      HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += String(chunk)));

  try {
    await Promise.race([
      waitForServer(),
      exited.then(() => { throw new Error(`隔离测试服务提前退出\n${errors}`); }),
    ]);
    const csv = await readFile(
      path.join(root, "data", "software-development-demo-utf8.csv"),
      "utf8",
    );
    const initial = await request<{ batchId: number }>("/api/import/prepare", {
      filename: "initial.csv",
      csv,
      config: DEFAULT_CONFIG,
    });
    await request(`/api/import-batches/${initial.batchId}/publish`, {});

    const parsed = parseCsv(csv);
    const oldTeamA = parsed.rows.find(
      (row) => row.team === "Team A" && row.priority === "P1",
    )!;
    const oldItem = await request<any>(
      `/api/work-items/${encodeURIComponent(oldTeamA.ticket_id)}`,
    );
    assert.equal(
      oldItem.observations.find(
        (item: any) => item.stage_id === "wait_development",
      ).sla_hours,
      12,
    );

    const teamConfig = structuredClone(DEFAULT_CONFIG);
    teamConfig.teamSlaHours = {
      "Team A": { wait_development: { P1: 6 } },
    };
    const draft = await request<{ id: number }>(
      "/api/process-versions/drafts",
      {
        config: teamConfig,
        baselines: {
          releaseSuccessTarget: 0.9,
          slaAchievementTarget: { P0: 1, P1: 0.8, P2: 0.8 },
        },
        changeNote: "Team A 等待开发 P1 调整为 6h",
      },
    );
    await request(`/api/process-versions/${draft.id}/publish`, {});

    const [historicalOld, simulatedOld, simulatedState] = await Promise.all([
      request<any>(`/api/work-items/${encodeURIComponent(oldTeamA.ticket_id)}`),
      request<any>(
        `/api/work-items/${encodeURIComponent(oldTeamA.ticket_id)}?slaMode=current`,
      ),
      request<any>("/api/state?priority=P1&slaMode=current"),
    ]);
    const historicalObservation = historicalOld.observations.find(
      (item: any) => item.stage_id === "wait_development",
    );
    const simulatedObservation = simulatedOld.observations.find(
      (item: any) => item.stage_id === "wait_development",
    );
    assert.equal(historicalObservation.sla_hours, 12);
    assert.equal(simulatedObservation.sla_hours, 6);
    assert.equal(simulatedOld.calculationMode, "current-config-simulation");
    assert.equal(
      simulatedState.dashboard.calculationMode,
      "current-config-simulation",
    );

    const sourceA = parsed.rows.find(
      (row) => row.team === "Team A" && row.priority === "P1",
    )!;
    const sourceB = parsed.rows.find(
      (row) => row.team === "Team B" && row.priority === "P1",
    )!;
    const incrementalCsv = Papa.unparse([
      { ...sourceA, ticket_id: "TEAM-SLA-A-NEW", title: "Team A 新事项" },
      { ...sourceB, ticket_id: "TEAM-SLA-B-NEW", title: "Team B 新事项" },
    ]);
    const incremental = await request<{ batchId: number }>(
      "/api/import/prepare",
      {
        filename: "team-sla-increment.csv",
        csv: incrementalCsv,
        config: teamConfig,
      },
    );
    await request(`/api/import-batches/${incremental.batchId}/publish`, {});

    const [newA, newB, oldAfter, state] = await Promise.all([
      request<any>("/api/work-items/TEAM-SLA-A-NEW"),
      request<any>("/api/work-items/TEAM-SLA-B-NEW"),
      request<any>(`/api/work-items/${encodeURIComponent(oldTeamA.ticket_id)}`),
      request<any>("/api/state?priority=P1"),
    ]);
    const waitDevelopmentSla = (item: any) =>
      item.observations.find(
        (observation: any) => observation.stage_id === "wait_development",
      ).sla_hours;
    assert.equal(waitDevelopmentSla(newA), 6);
    assert.equal(waitDevelopmentSla(newB), 12);
    assert.equal(waitDevelopmentSla(oldAfter), 12);

    const baseline = (team: string) =>
      state.dashboard.teamMatrix
        .find((row: any) => row.team === team)
        .stages.find((stage: any) => stage.id === "wait_development")
        .comparisonSlaHours;
    assert.equal(baseline("Team A"), 6);
    assert.equal(baseline("Team B"), 12);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(databasePath, { force: true });
  }
});
