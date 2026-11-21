import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  compareProcessStructure,
  normalizeRows,
  parseCsv,
  resolveSlaHours,
  simulateMeasurementsWithCurrentSla,
  summarizeDashboard,
  summarizeStages,
  validateConfig,
} from "../../../packages/core/v01.js";
import type {
  ProcessConfig,
  StageMeasurement,
} from "../../../packages/contracts/v01.js";
import {
  nextProblemStatus,
  problemTransitionError,
} from "../../../packages/core/problem-workflow.js";
import {
  closePostgres,
  getPostgresStatus,
  initializePostgres,
} from "./postgres.js";
import { storage, storageKind } from "./storage.js";
import {
  createDataSource,
  configureDataSource,
  getSyncRunDetails,
  listDataSources,
  listSourceObjects,
  listSyncRuns,
  publishSyncRun,
  previewSourceObject,
  runFullSync,
  runIncrementalSync,
  retrySyncRun,
  startDataSourceScheduler,
  testDataSource,
  updateDataSourceSchedule,
} from "./data-sources.js";
import {
  actorFromRequest,
  audit,
  authRequired,
  bootstrapAdmin,
  bootstrapConfigured,
  can,
  changeOwnPassword,
  clearSessionCookie,
  createUser,
  listUsers,
  listAuditEvents,
  login,
  logout,
  needsBootstrap,
  passwordError,
  resetUserPassword,
  setUserActive,
  scopedTeams,
  sessionCookie,
  validBootstrapToken,
  type Actor,
} from "./auth.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const webDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);
const appVersion = JSON.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../package.json",
    ),
    "utf8",
  ),
).version as string;

function json(
  res: http.ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

async function body(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    any
  >;
}

async function currentConfig() {
  return (
    (await storage.getSetting<ProcessConfig>("process_config")) ??
    DEFAULT_CONFIG
  );
}

async function visibleProblems(actor: Actor | null) {
  return storage.listProblems(actor ? scopedTeams(actor) : null);
}

async function workItems(filters: URLSearchParams, actor?: Actor | null) {
  const rows = await storage.listWorkItemsRaw();
  const config = await currentConfig();
  const from = filters.get("from"),
    to = filters.get("to"),
    teams = filters.getAll("team"),
    priority = filters.get("priority"),
    allowedTeams = actor ? scopedTeams(actor) : null;
  return rows.filter((row) => {
    const source = JSON.parse(row.source_json) as Record<string, string>;
    const started = source[config.stages[0].startField];
    return (
      (!teams.length || teams.includes(row.team)) &&
      (allowedTeams === null || allowedTeams.includes(row.team)) &&
      (!priority || row.priority === priority) &&
      (!from || started >= `${from}T00:00:00`) &&
      (!to || started <= `${to}T23:59:59`)
    );
  });
}

async function measurementsFor(
  ticketIds: string[],
  options: {
    currentSla?: boolean;
    config?: ProcessConfig;
    teamByTicket?: Record<string, string>;
  } = {},
) {
  const rows = await storage.listStageObservationsForTickets(ticketIds);
  const measurements = rows.map((row) => {
    const activeHours =
      row.state === "active" && row.started_at
        ? Math.max(0, (Date.now() - Date.parse(row.started_at)) / 3_600_000)
        : row.hours;
    return {
      ticketId: row.ticket_id,
      stageId: row.stage_id,
      stageName: row.stage_name,
      stageType: row.stage_type,
      priority: row.priority,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      state: row.state,
      hours: activeHours,
      slaHours: row.sla_hours,
      overdue:
        activeHours === null ? null : Boolean(activeHours > row.sla_hours),
    };
  }) as StageMeasurement[];
  return options.currentSla && options.config
    ? simulateMeasurementsWithCurrentSla(
        measurements,
        options.config,
        options.teamByTicket ?? {},
      )
    : measurements;
}

async function operations(
  filters = new URLSearchParams(),
  actor?: Actor | null,
) {
  const items = await workItems(filters, actor);
  const visibleIds = new Set(items.map((row) => row.ticket_id));
  const scope = actor ? scopedTeams(actor) : null;
  const config = await currentConfig();
  const measurements = await measurementsFor(
    items.map((row) => row.ticket_id),
    {
      currentSla: filters.get("slaMode") === "current",
      config,
      teamByTicket: Object.fromEntries(
        items.map((row) => [row.ticket_id, row.team]),
      ),
    },
  );
  return {
    items: items.map((row) => ({
      ticketId: row.ticket_id,
      title: row.title,
      team: row.team,
      priority: row.priority,
      currentStatus: row.current_status,
      releaseResult: row.release_result,
      source: JSON.parse(row.source_json),
    })),
    measurements,
    reasons: (await storage.listOperationalReasons(scope)).filter((reason: any) =>
      visibleIds.has(reason.ticket_id),
    ),
    baselines: (await storage.getSetting("operation_baselines")) ?? {
      releaseSuccessTarget: 0.9,
      slaAchievementTarget: { P0: 1, P1: 0.8, P2: 0.8 },
    },
  };
}

async function dashboard(
  filters = new URLSearchParams(),
  actor?: Actor | null,
) {
  const config = await currentConfig();
  const items = await workItems(filters, actor);
  const currentSla = filters.get("slaMode") === "current";
  const sourceRows = items.map(
    (row) => JSON.parse(row.source_json) as Record<string, string>,
  );
  const measurements = await measurementsFor(
    items.map((row) => row.ticket_id),
    {
      currentSla,
      config,
      teamByTicket: Object.fromEntries(
        items.map((row) => [row.ticket_id, row.team]),
      ),
    },
  );
  const comparisonPriority = (filters.get("priority") ?? "P1") as
    "P0" | "P1" | "P2";
  const latest = await storage.getLatestPublishedBatch();
  const storedTeams = await storage.listWorkItemTeams();
  const scope = actor ? scopedTeams(actor) : null;
  const allTeams =
    scope === null
      ? storedTeams
      : storedTeams.filter((team) => scope.includes(team));
  const visibleTeams = [...new Set(items.map((row) => row.team))];
  const summary = summarizeDashboard(sourceRows, measurements, config, 0);
  const publishedRowCount = Number(latest?.total_rows ?? 0);
  summary.dataValidRate =
    scope === null && publishedRowCount > 0
      ? Number(latest.valid_rows) / publishedRowCount
      : null;
  return {
    summary,
    stages: summarizeStages(
      measurements,
      config,
      undefined,
      comparisonPriority,
    ),
    teams: allTeams,
    teamMatrix: await Promise.all(
      visibleTeams.map(async (team) => {
        const teamItems = items.filter((row) => row.team === team);
        const teamIds = new Set(teamItems.map((row) => row.ticket_id));
        const teamMeasurements = measurements.filter((item) =>
          teamIds.has(item.ticketId),
        );
        return {
          team,
          ticketCount: teamItems.length,
          stages: summarizeStages(
            teamMeasurements,
            config,
            team,
            comparisonPriority,
          ),
        };
      }),
    ),
    lastImport:
      latest && scope !== null ? { imported_at: latest.imported_at } : latest ?? null,
    calculationMode: currentSla
      ? "current-config-simulation"
      : "historical-config",
  };
}

async function api(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) {
  if (req.method === "GET" && url.pathname === "/api/health")
    return json(res, 200, {
      status: "ok",
      version: appVersion,
      storage: storageKind,
      postgres: getPostgresStatus(),
      checkedAt: new Date().toISOString(),
    });
  if (req.method === "GET" && url.pathname === "/api/auth/status")
    return json(res, 200, {
      required: authRequired,
      needsBootstrap: authRequired ? await needsBootstrap() : false,
    });
  if (req.method === "POST" && url.pathname === "/api/auth/bootstrap") {
    if (!authRequired) return json(res, 400, { message: "当前模式不启用账号" });
    if (!bootstrapConfigured)
      return json(res, 503, { message: "请让部署管理员设置初始化令牌后重启应用" });
    const { token, username, displayName, password } = await body(req);
    if (!validBootstrapToken(token))
      return json(res, 403, { message: "初始化令牌无效" });
    if (
      typeof username !== "string" || !username.trim() ||
      typeof displayName !== "string" || !displayName.trim() ||
      typeof password !== "string"
    )
      return json(res, 400, { message: "请输入用户名、显示名称和密码" });
    const error = passwordError(password);
    if (error) return json(res, 400, { message: error });
    if (!(await bootstrapAdmin({ username, displayName, password }, req)))
      return json(res, 409, { message: "系统已经完成管理员初始化" });
    return json(res, 201, { created: true });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!authRequired) return json(res, 400, { message: "当前模式不启用账号" });
    const input = await body(req);
    const result = await login(
      String(input.username ?? ""),
      String(input.password ?? ""),
      req,
    );
    if (!result)
      return json(res, 401, { message: "用户名或密码错误，或账号暂时锁定" });
    return json(
      res,
      200,
      { user: result.actor },
      { "set-cookie": sessionCookie(result.token) },
    );
  }
  const actor = authRequired ? await actorFromRequest(req) : null;
  if (authRequired && !actor) return json(res, 401, { message: "请先登录" });
  if (req.method === "GET" && url.pathname === "/api/auth/me")
    return json(res, 200, { user: actor });
  if (req.method === "POST" && url.pathname === "/api/auth/logout" && actor) {
    await logout(actor, req);
    return json(
      res,
      200,
      { loggedOut: true },
      { "set-cookie": clearSessionCookie() },
    );
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/auth/change-password" &&
    actor
  ) {
    const input = await body(req);
    await changeOwnPassword(
      actor,
      String(input.currentPassword ?? ""),
      String(input.newPassword ?? ""),
    );
    await audit(
      actor,
      req,
      "AUTH_PASSWORD_CHANGE",
      "user",
      String(actor.id),
      "SUCCESS",
    );
    return json(res, 200, { changed: true });
  }
  if (actor?.mustChangePassword)
    return json(res, 403, {
      message: "首次登录或密码重置后必须先修改密码",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  const requireCapability = async (capability: string, action: string) => {
    if (!actor || can(actor, capability)) return true;
    await audit(actor, req, action, "request", url.pathname, "DENIED");
    json(res, 403, { message: "当前账号没有执行此操作的权限" });
    return false;
  };
  if (req.method === "GET" && url.pathname === "/api/process-spaces") {
    return json(res, 200, { processSpaces: await storage.listProcessSpaces() });
  }
  if (req.method === "POST" && url.pathname === "/api/process-spaces") {
    if (
      !(await requireCapability("manage_data_sources", "PROCESS_SPACE_CREATE"))
    )
      return;
    const input = await body(req);
    const name = String(input.name ?? "").trim();
    const code = String(input.code ?? "")
      .trim()
      .toLowerCase();
    const description = String(input.description ?? "").trim();
    const owner = String(input.owner ?? "").trim();
    if (!name) return json(res, 400, { message: "流程空间名称为必填" });
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(code))
      return json(res, 400, {
        message: "空间编码需为 2—32 位小写字母、数字或连字符，且以字母开头",
      });
    const created = await storage.createProcessSpace({
      name,
      code,
      description,
      owner,
    });
    if (actor)
      await audit(
        actor,
        req,
        "PROCESS_SPACE_CREATE",
        "process_space",
        String(created.id),
        "SUCCESS",
        { name, code },
      );
    return json(res, 201, created);
  }
  const processSpaceStatusMatch = url.pathname.match(
    /^\/api\/process-spaces\/(\d+)\/status$/,
  );
  if (req.method === "POST" && processSpaceStatusMatch) {
    if (
      !(await requireCapability(
        "manage_data_sources",
        "PROCESS_SPACE_STATUS_UPDATE",
      ))
    )
      return;
    const input = await body(req);
    const status = String(input.status ?? "");
    if (!(["ACTIVE", "INACTIVE"] as const).includes(status as any))
      return json(res, 400, { message: "流程空间状态无效" });
    const id = Number(processSpaceStatusMatch[1]);
    await storage.updateProcessSpaceStatus(id, status as "ACTIVE" | "INACTIVE");
    if (actor)
      await audit(
        actor,
        req,
        "PROCESS_SPACE_STATUS_UPDATE",
        "process_space",
        String(id),
        "SUCCESS",
        { status },
      );
    return json(res, 200, { updated: true });
  }
  if (req.method === "GET" && url.pathname === "/api/audit-events") {
    if (!(await requireCapability("audit", "AUDIT_READ"))) return;
    return json(res, 200, { events: await listAuditEvents() });
  }
  if (req.method === "GET" && url.pathname === "/api/data-sources") {
    if (!(await requireCapability("manage_data_sources", "DATA_SOURCE_LIST")))
      return;
    return json(res, 200, { dataSources: await listDataSources() });
  }
  if (req.method === "GET" && url.pathname === "/api/sync-runs") {
    if (!(await requireCapability("manage_data_sources", "SYNC_RUN_LIST")))
      return;
    const dataSourceId = Number(url.searchParams.get("dataSourceId") ?? 0);
    return json(res, 200, {
      syncRuns: await listSyncRuns(dataSourceId || undefined),
    });
  }
  const syncRunDetailMatch = url.pathname.match(/^\/api\/sync-runs\/(\d+)$/);
  if (req.method === "GET" && syncRunDetailMatch) {
    if (!(await requireCapability("manage_data_sources", "SYNC_RUN_READ")))
      return;
    const details = await getSyncRunDetails(Number(syncRunDetailMatch[1]));
    if (!details) return json(res, 404, { message: "同步批次不存在" });
    return json(res, 200, details);
  }
  const syncRunRetryMatch = url.pathname.match(
    /^\/api\/sync-runs\/(\d+)\/retry$/,
  );
  if (req.method === "POST" && syncRunRetryMatch) {
    if (!(await requireCapability("manage_data_sources", "SYNC_RUN_RETRY")))
      return;
    const originalId = Number(syncRunRetryMatch[1]);
    const result = await retrySyncRun(originalId);
    if (actor)
      await audit(
        actor,
        req,
        "SYNC_RUN_RETRY",
        "sync_run",
        String(originalId),
        "SUCCESS",
        {
          newSyncRunId: result.syncRunId,
        },
      );
    return json(res, 201, result);
  }
  if (req.method === "POST" && url.pathname === "/api/data-sources") {
    if (!(await requireCapability("manage_data_sources", "DATA_SOURCE_CREATE")))
      return;
    const input = await body(req);
    const id = await createDataSource(input as any, actor?.id);
    if (actor)
      await audit(
        actor,
        req,
        "DATA_SOURCE_CREATE",
        "data_source",
        String(id),
        "SUCCESS",
        { connectorType: "POSTGRESQL", name: String(input.name ?? "") },
      );
    return json(res, 201, { id, dataSources: await listDataSources() });
  }
  const dataSourceTestMatch = url.pathname.match(
    /^\/api\/data-sources\/(\d+)\/test$/,
  );
  if (req.method === "POST" && dataSourceTestMatch) {
    if (!(await requireCapability("manage_data_sources", "DATA_SOURCE_TEST")))
      return;
    const id = Number(dataSourceTestMatch[1]);
    const result = await testDataSource(id);
    if (actor)
      await audit(
        actor,
        req,
        "DATA_SOURCE_TEST",
        "data_source",
        String(id),
        "SUCCESS",
        { sessionReadOnly: result.sessionReadOnly },
      );
    return json(res, 200, result);
  }
  const dataSourceObjectsMatch = url.pathname.match(
    /^\/api\/data-sources\/(\d+)\/objects$/,
  );
  if (req.method === "GET" && dataSourceObjectsMatch) {
    if (!(await requireCapability("manage_data_sources", "DATA_SOURCE_BROWSE")))
      return;
    return json(res, 200, {
      objects: await listSourceObjects(Number(dataSourceObjectsMatch[1])),
    });
  }
  const dataSourcePreviewMatch = url.pathname.match(
    /^\/api\/data-sources\/(\d+)\/preview$/,
  );
  if (req.method === "POST" && dataSourcePreviewMatch) {
    if (
      !(await requireCapability("manage_data_sources", "DATA_SOURCE_PREVIEW"))
    )
      return;
    const input = await body(req);
    return json(
      res,
      200,
      await previewSourceObject(
        Number(dataSourcePreviewMatch[1]),
        String(input.schemaName ?? ""),
        String(input.objectName ?? ""),
      ),
    );
  }
  const dataSourceConfigureMatch = url.pathname.match(
    /^\/api\/data-sources\/(\d+)\/configuration$/,
  );
  if (req.method === "POST" && dataSourceConfigureMatch) {
    if (
      !(await requireCapability("manage_data_sources", "DATA_SOURCE_CONFIGURE"))
    )
      return;
    const id = Number(dataSourceConfigureMatch[1]);
    const result = await configureDataSource(
      id,
      (await body(req)) as any,
      actor?.id,
    );
    if (actor)
      await audit(
        actor,
        req,
        "DATA_SOURCE_CONFIGURE",
        "data_source",
        String(id),
        "SUCCESS",
        { mappingVersion: result.versionNo },
      );
    return json(res, 200, { ...result, dataSources: await listDataSources() });
  }
  const dataSourceFullSyncMatch = url.pathname.match(
    /^\/api\/data-sources\/(\d+)\/full-sync$/,
  );
  if (req.method === "POST" && dataSourceFullSyncMatch) {
    if (
      !(await requireCapability("manage_data_sources", "DATA_SOURCE_FULL_SYNC"))
    )
      return;
    const id = Number(dataSourceFullSyncMatch[1]);
    const result = await runFullSync(id);
    if (actor)
      await audit(
        actor,
        req,
        "DATA_SOURCE_FULL_SYNC",
        "data_source",
        String(id),
        "SUCCESS",
        {
          syncRunId: result.syncRunId,
          rowsRead: result.rowsRead,
          errorRows: result.errorRows,
        },
      );
    return json(res, 201, result);
  }
  const dataSourceIncrementalSyncMatch = url.pathname.match(
    /^\/api\/data-sources\/(\d+)\/incremental-sync$/,
  );
  if (req.method === "POST" && dataSourceIncrementalSyncMatch) {
    if (
      !(await requireCapability(
        "manage_data_sources",
        "DATA_SOURCE_INCREMENTAL_SYNC",
      ))
    )
      return;
    const id = Number(dataSourceIncrementalSyncMatch[1]);
    const result = await runIncrementalSync(id);
    if (actor)
      await audit(
        actor,
        req,
        "DATA_SOURCE_INCREMENTAL_SYNC",
        "data_source",
        String(id),
        "SUCCESS",
        {
          syncRunId: result.syncRunId,
          newRows: result.newRows,
          updatedRows: result.updatedRows,
          unchangedRows: result.unchangedRows,
        },
      );
    return json(res, 201, result);
  }
  const dataSourceScheduleMatch = url.pathname.match(
    /^\/api\/data-sources\/(\d+)\/schedule$/,
  );
  if (req.method === "POST" && dataSourceScheduleMatch) {
    if (
      !(await requireCapability("manage_data_sources", "DATA_SOURCE_SCHEDULE"))
    )
      return;
    const id = Number(dataSourceScheduleMatch[1]);
    const schedule = await updateDataSourceSchedule(
      id,
      (await body(req)) as any,
    );
    if (actor)
      await audit(
        actor,
        req,
        "DATA_SOURCE_SCHEDULE",
        "data_source",
        String(id),
        "SUCCESS",
        {
          enabled: schedule.enabled,
          hour: schedule.hour,
          minute: schedule.minute,
          timezone: schedule.timezone,
        },
      );
    return json(res, 200, { schedule, dataSources: await listDataSources() });
  }
  const syncRunPublishMatch = url.pathname.match(
    /^\/api\/sync-runs\/(\d+)\/publish$/,
  );
  if (req.method === "POST" && syncRunPublishMatch) {
    if (!(await requireCapability("publish_data", "SYNC_RUN_PUBLISH"))) return;
    const result = await publishSyncRun(Number(syncRunPublishMatch[1]));
    if (actor)
      await audit(
        actor,
        req,
        "SYNC_RUN_PUBLISH",
        "sync_run",
        String(result.syncRunId),
        "SUCCESS",
        {
          batchId: result.batchId,
        },
      );
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/users") {
    if (!(await requireCapability("manage_users", "USER_CREATE"))) return;
    const input = await body(req);
    const id = await createUser(input as any);
    if (actor)
      await audit(actor, req, "USER_CREATE", "user", String(id), "SUCCESS", {
        role: input.role,
        teams: input.teams ?? [],
      });
    return json(res, 201, { id });
  }
  if (req.method === "GET" && url.pathname === "/api/users") {
    if (!(await requireCapability("manage_users", "USER_LIST"))) return;
    return json(res, 200, { users: await listUsers() });
  }
  const userActiveMatch = url.pathname.match(/^\/api\/users\/(\d+)\/active$/);
  if (req.method === "POST" && userActiveMatch) {
    if (!(await requireCapability("manage_users", "USER_ACTIVE_UPDATE")))
      return;
    const id = Number(userActiveMatch[1]);
    if (actor?.id === id)
      return json(res, 400, { message: "不能在当前会话中禁用自己的账号" });
    const input = await body(req);
    await setUserActive(id, Boolean(input.active));
    if (actor)
      await audit(
        actor,
        req,
        "USER_ACTIVE_UPDATE",
        "user",
        String(id),
        "SUCCESS",
        { active: Boolean(input.active) },
      );
    return json(res, 200, { users: await listUsers() });
  }
  const userPasswordMatch = url.pathname.match(
    /^\/api\/users\/(\d+)\/reset-password$/,
  );
  if (req.method === "POST" && userPasswordMatch) {
    if (!(await requireCapability("manage_users", "USER_PASSWORD_RESET")))
      return;
    const id = Number(userPasswordMatch[1]);
    const input = await body(req);
    await resetUserPassword(id, String(input.password ?? ""));
    if (actor)
      await audit(
        actor,
        req,
        "USER_PASSWORD_RESET",
        "user",
        String(id),
        "SUCCESS",
      );
    return json(res, 200, { reset: true });
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    const scope = actor ? scopedTeams(actor) : null;
    const visibleConfig = structuredClone(await currentConfig());
    if (scope !== null && visibleConfig.teamSlaHours)
      visibleConfig.teamSlaHours = Object.fromEntries(
        Object.entries(visibleConfig.teamSlaHours).filter(([team]) =>
          scope.includes(team),
        ),
      );
    return json(res, 200, {
      config: visibleConfig,
      dashboard: await dashboard(url.searchParams, actor),
      operations: await operations(url.searchParams, actor),
      importBatches: scope === null ? await storage.listImportBatches() : [],
      processVersions:
        scope === null ? await storage.listProcessVersions() : [],
      problems: await visibleProblems(actor),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/reset") {
    if (!storage.resetDemo)
      return json(res, 403, { message: "仅 SQLite 演示模式可以重置数据" });
    const input = await body(req);
    if (input.confirm !== "RESET_DEMO")
      return json(res, 400, { message: "缺少重置确认" });
    await storage.resetDemo();
    return json(res, 200, {
      reset: true,
      config: await currentConfig(),
      dashboard: await dashboard(),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/import/preview") {
    const input = await body(req),
      parsed = parseCsv(String(input.csv ?? ""));
    return json(res, 200, {
      headers: parsed.headers,
      rowCount: parsed.rows.length,
      preview: parsed.rows.slice(0, 20),
      parseErrors: parsed.errors,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/import/prepare") {
    if (!(await requireCapability("import", "IMPORT_PREPARE"))) return;
    const input = await body(req),
      config = input.config as ProcessConfig,
      parsed = parseCsv(String(input.csv ?? ""));
    const configErrors = validateConfig(config, parsed.headers);
    if (parsed.errors.length || configErrors.length)
      return json(res, 400, {
        message: "CSV 或配置无法导入",
        configErrors,
        issues: parsed.errors,
      });
    const asOf = new Date().toISOString(),
      normalized = normalizeRows(parsed.rows, config, asOf);
    if (!normalized.validRows.length)
      return json(res, 400, {
        message: "没有可导入的有效记录",
        issues: normalized.issues,
      });
    const hasPublishedConfig = (await storage.listProcessVersions()).some(
      (version: any) => version.status === "PUBLISHED",
    );
    const structureDiff = hasPublishedConfig
      ? compareProcessStructure(await currentConfig(), config)
      : { changed: false, changes: [] };
    const prepared = await storage.prepareImportBatch(
      String(input.filename ?? "upload.csv"),
      asOf,
      parsed.rows.length,
      normalized.validRows,
      normalized.measurements,
      config,
      normalized.issues,
      structureDiff,
    );
    if (actor)
      await audit(
        actor,
        req,
        "IMPORT_PREPARE",
        "import_batch",
        String(prepared.batchId),
        "SUCCESS",
        {
          filename: String(input.filename ?? "upload.csv"),
          totalRows: parsed.rows.length,
        },
      );
    return json(res, 200, {
      ...prepared,
      validRows: normalized.validRows.length,
      excludedRows: parsed.rows.length - normalized.validRows.length,
      issues: normalized.issues,
      structureDiff,
    });
  }
  const publishMatch = url.pathname.match(
    /^\/api\/import-batches\/(\d+)\/publish$/,
  );
  if (req.method === "POST" && publishMatch) {
    if (!(await requireCapability("publish_data", "IMPORT_PUBLISH"))) return;
    const input = await body(req);
    let result;
    try {
      result = await storage.publishImportBatch(
        Number(publishMatch[1]),
        input.confirmStructureOverride === "OVERWRITE_PROCESS",
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("流程结构发生变化"))
        return json(res, 409, {
          message: error.message,
          code: "STRUCTURE_DECISION_REQUIRED",
        });
      throw error;
    }
    if (actor)
      await audit(
        actor,
        req,
        "IMPORT_PUBLISH",
        "import_batch",
        publishMatch[1],
        "SUCCESS",
      );
    return json(res, 200, { ...result, dashboard: await dashboard() });
  }
  const rejectMatch = url.pathname.match(
    /^\/api\/import-batches\/(\d+)\/reject$/,
  );
  if (req.method === "POST" && rejectMatch) {
    if (!(await requireCapability("publish_data", "IMPORT_REJECT"))) return;
    await storage.rejectImportBatch(Number(rejectMatch[1]));
    if (actor)
      await audit(
        actor,
        req,
        "IMPORT_REJECT",
        "import_batch",
        rejectMatch[1],
        "SUCCESS",
      );
    return json(res, 200, { rejected: true });
  }
  if (req.method === "POST" && url.pathname === "/api/config") {
    if (!(await requireCapability("configure", "CONFIG_UPDATE"))) return;
    const input = await body(req),
      config = input.config as ProcessConfig;
    const sample = await storage.getSampleSource();
    const errors = validateConfig(
      config,
      sample ? Object.keys(JSON.parse(sample.source_json)) : [],
    );
    if (errors.length)
      return json(res, 400, { message: "流程配置无效", configErrors: errors });
    await storage.updateProcessConfig(config);
    if (actor)
      await audit(
        actor,
        req,
        "CONFIG_UPDATE",
        "process_config",
        null,
        "SUCCESS",
      );
    return json(res, 200, { config, dashboard: await dashboard() });
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/process-versions/drafts"
  ) {
    if (!(await requireCapability("configure", "CONFIG_DRAFT_CREATE"))) return;
    const input = await body(req);
    const config = input.config as ProcessConfig;
    const sample = await storage.getSampleSource();
    const errors = validateConfig(
      config,
      sample ? Object.keys(JSON.parse(sample.source_json)) : [],
    );
    if (errors.length)
      return json(res, 400, { message: "配置草稿无效", configErrors: errors });
    const draft = await storage.createProcessVersionDraft(
      config,
      input.baselines,
      String(input.changeNote ?? "").trim() || "未填写变更说明",
    );
    if (actor)
      await audit(
        actor,
        req,
        "CONFIG_DRAFT_CREATE",
        "process_version",
        String(draft.id),
        "SUCCESS",
        { changeNote: String(input.changeNote ?? "") },
      );
    return json(res, 201, {
      ...draft,
      versions: await storage.listProcessVersions(),
    });
  }
  const versionPublishMatch = url.pathname.match(
    /^\/api\/process-versions\/(\d+)\/publish$/,
  );
  if (req.method === "POST" && versionPublishMatch) {
    if (!(await requireCapability("publish_config", "CONFIG_PUBLISH"))) return;
    const result = await storage.publishProcessVersion(
      Number(versionPublishMatch[1]),
    );
    if (actor)
      await audit(
        actor,
        req,
        "CONFIG_PUBLISH",
        "process_version",
        versionPublishMatch[1],
        "SUCCESS",
      );
    return json(res, 200, {
      ...result,
      versions: await storage.listProcessVersions(),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/operation-baselines") {
    if (!(await requireCapability("configure", "BASELINE_UPDATE"))) return;
    const input = await body(req);
    await storage.setSetting("operation_baselines", input);
    if (actor)
      await audit(
        actor,
        req,
        "BASELINE_UPDATE",
        "setting",
        "operation_baselines",
        "SUCCESS",
      );
    return json(res, 200, input);
  }
  if (req.method === "POST" && url.pathname === "/api/operational-reasons") {
    if (!(await requireCapability("reason", "OPERATIONAL_REASON_SAVE"))) return;
    const input = await body(req);
    if (
      !input.ticketId ||
      !input.stageId ||
      !input.kind ||
      !input.responsibleTeam ||
      !input.owner ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate ?? ""))
    )
      return json(res, 400, {
        message: "责任团队、负责人和计划完成日期均为必填",
      });
    const category = String(input.category ?? "");
    const detail = String(input.detail ?? "").trim();
    if (Boolean(category) !== Boolean(detail))
      return json(res, 400, { message: "原因分类和原因说明需要同时填写" });
    const scope = actor ? scopedTeams(actor) : null;
    const saved = await storage.saveOperationalReason({
      ticketId: String(input.ticketId),
      stageId: String(input.stageId),
      kind: String(input.kind),
      category,
      detail,
      responsibleTeam: String(input.responsibleTeam),
      owner: String(input.owner),
      dueDate: String(input.dueDate),
      status: category && detail ? "已填写" : "待填写",
    }, scope);
    if (!saved) {
      if (actor)
        await audit(actor, req, "OPERATIONAL_REASON_SAVE", "work_item", String(input.ticketId), "DENIED");
      return json(res, 403, { message: "不能修改未授权团队的事项或不存在的事项" });
    }
    if (actor)
      await audit(
        actor,
        req,
        "OPERATIONAL_REASON_SAVE",
        "work_item",
        String(input.ticketId),
        "SUCCESS",
        { stageId: input.stageId, kind: input.kind },
      );
    return json(res, 201, {
      reasons: await storage.listOperationalReasons(scope),
    });
  }
  const stageMatch = url.pathname.match(/^\/api\/stages\/([^/]+)$/);
  if (req.method === "GET" && stageMatch) {
    const items = await workItems(url.searchParams, actor),
      ids = new Set(items.map((row) => row.ticket_id)),
      stageId = decodeURIComponent(stageMatch[1]);
    const observations = (
      await storage.listStageObservationsForStage(stageId)
    ).filter((row) => ids.has(row.ticket_id));
    const byId = new Map(items.map((row) => [row.ticket_id, row]));
    const simulate = url.searchParams.get("slaMode") === "current";
    const config = simulate ? await currentConfig() : null;
    return json(
      res,
      200,
      observations.map((row) => {
        const item = byId.get(row.ticket_id);
        const activeHours =
          row.state === "active" && row.started_at
            ? Math.max(0, (Date.now() - Date.parse(row.started_at)) / 3_600_000)
            : row.hours;
        const stage = config?.stages.find(
          (candidate) => candidate.id === row.stage_id,
        );
        const slaHours =
          config && stage
            ? resolveSlaHours(config, stage, row.priority, item?.team)
            : Number(row.sla_hours);
        return {
          ...row,
          hours: activeHours,
          sla_hours: slaHours,
          overdue: activeHours === null ? null : activeHours > slaHours,
          title: item?.title,
          team: item?.team,
        };
      }),
    );
  }
  const itemMatch = url.pathname.match(/^\/api\/work-items\/([^/]+)$/);
  if (req.method === "GET" && itemMatch) {
    const ticketId = decodeURIComponent(itemMatch[1]),
      item = await storage.getWorkItemWithObservations(ticketId);
    if (!item) return json(res, 404, { message: "未找到单据" });
    if (actor) {
      const scope = scopedTeams(actor);
      if (scope !== null && !scope.includes(item.team))
        return json(res, 404, { message: "未找到单据" });
    }
    if (url.searchParams.get("slaMode") === "current") {
      const config = await currentConfig();
      item.observations = item.observations.map((row: any) => {
        const stage = config.stages.find(
          (candidate) => candidate.id === row.stage_id,
        );
        if (!stage) return row;
        const activeHours =
          row.state === "active" && row.started_at
            ? Math.max(0, (Date.now() - Date.parse(row.started_at)) / 3_600_000)
            : row.hours;
        const slaHours = resolveSlaHours(
          config,
          stage,
          row.priority,
          item.team,
        );
        return {
          ...row,
          hours: activeHours,
          sla_hours: slaHours,
          overdue: activeHours === null ? null : activeHours > slaHours,
        };
      });
      item.calculationMode = "current-config-simulation";
    }
    return json(res, 200, item);
  }
  if (req.method === "POST" && url.pathname === "/api/problems") {
    if (!(await requireCapability("operate", "PROBLEM_CREATE"))) return;
    const input = await body(req);
    if (
      !input.title?.trim() ||
      !input.impact?.trim() ||
      !input.owner?.trim() ||
      !input.team?.trim()
    )
      return json(res, 400, {
        message: "改进项名称、改进说明、所属团队和负责人均为必填",
      });
    const scope = actor ? scopedTeams(actor) : null;
    const team = input.team.trim();
    if (scope !== null && !scope.includes(team))
      return json(res, 403, { message: "不能为未授权团队创建改进项" });
    const id = await storage.createProblem({
      title: input.title,
      stageId: "",
      impact: input.impact,
      owner: input.owner,
      team,
      ticketIds: [],
    });
    if (actor)
      await audit(
        actor,
        req,
        "PROBLEM_CREATE",
        "problem",
        String(id),
        "SUCCESS",
      );
    return json(res, 201, { id, problems: await visibleProblems(actor) });
  }
  const problemEditMatch = url.pathname.match(/^\/api\/problems\/(\d+)$/);
  if (req.method === "POST" && problemEditMatch) {
    if (!(await requireCapability("operate", "PROBLEM_UPDATE"))) return;
    const id = Number(problemEditMatch[1]);
    const problem = (await storage.listProblems()).find(
      (candidate: any) => Number(candidate.id) === id,
    );
    if (!problem) return json(res, 404, { message: "改进项不存在" });
    const input = await body(req);
    if (
      !input.title?.trim() ||
      !input.impact?.trim() ||
      !input.owner?.trim() ||
      !input.team?.trim()
    )
      return json(res, 400, {
        message: "名称、说明、所属团队和负责人均为必填",
      });
    const scope = actor ? scopedTeams(actor) : null;
    const team = input.team.trim();
    if (
      scope !== null &&
      (!scope.includes(problem.team) || !scope.includes(team))
    )
      return json(res, 403, { message: "不能编辑或转移未授权团队的改进项" });
    const dueDate = String(input.dueDate ?? "").trim();
    if (problem.status !== "新建" && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
      return json(res, 400, {
        message: "进行中或已完成的改进项必须保留计划完成日期",
      });
    if (!(await storage.updateProblem(id, {
      title: String(input.title).trim(),
      impact: String(input.impact).trim(),
      owner: String(input.owner).trim(),
      team,
      dueDate: dueDate || undefined,
    }, scope)))
      return json(res, 409, { message: "改进项已变更，请刷新后重试" });
    if (actor)
      await audit(
        actor,
        req,
        "PROBLEM_UPDATE",
        "problem",
        String(id),
        "SUCCESS",
      );
    return json(res, 200, { problems: await visibleProblems(actor) });
  }
  const subMatch = url.pathname.match(
    /^\/api\/problems\/(\d+)\/(reasons|actions|verifications)$/,
  );
  if (req.method === "POST" && subMatch)
    return json(res, 410, {
      message: "持续改进项不再维护单据、原因、行动或复核子记录",
    });
  const problemStatusMatch = url.pathname.match(
    /^\/api\/problems\/(\d+)\/status$/,
  );
  if (req.method === "POST" && problemStatusMatch) {
    if (!(await requireCapability("operate", "PROBLEM_STATUS_UPDATE"))) return;
    const id = Number(problemStatusMatch[1]);
    const problem = (await storage.listProblems()).find(
      (candidate: any) => Number(candidate.id) === id,
    );
    if (!problem) return json(res, 404, { message: "问题不存在" });
    const scope = actor ? scopedTeams(actor) : null;
    if (scope !== null && !scope.includes(problem.team)) {
      if (actor)
        await audit(
          actor,
          req,
          "PROBLEM_STATUS_UPDATE",
          "problem",
          String(id),
          "DENIED",
        );
      return json(res, 403, { message: "不能更新未授权团队的改进项" });
    }
    const input = await body(req);
    const target = String(input.status ?? "");
    const dueDate = String(input.dueDate ?? "").trim();
    if (target === "进行中" && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
      return json(res, 400, { message: "进入进行中前必须填写计划完成日期" });
    const transitionError = problemTransitionError(problem, target);
    if (transitionError) return json(res, 409, { message: transitionError });
    if (!(await storage.updateProblemStatus(id, target, dueDate || undefined, scope)))
      return json(res, 409, { message: "改进项已变更，请刷新后重试" });
    if (actor)
      await audit(
        actor,
        req,
        "PROBLEM_STATUS_UPDATE",
        "problem",
        String(id),
        "SUCCESS",
        { before: problem.status, after: target },
      );
    return json(res, 200, { problems: await visibleProblems(actor) });
  }
  const actionStatusMatch = url.pathname.match(
    /^\/api\/problems\/(\d+)\/actions\/(\d+)\/status$/,
  );
  if (req.method === "POST" && actionStatusMatch) {
    if (!(await requireCapability("operate", "PROBLEM_ACTION_STATUS_UPDATE")))
      return;
    const problemId = Number(actionStatusMatch[1]);
    const actionId = Number(actionStatusMatch[2]);
    const problem = (await storage.listProblems()).find(
      (candidate: any) => Number(candidate.id) === problemId,
    );
    if (!problem) return json(res, 404, { message: "问题不存在" });
    const scope = actor ? scopedTeams(actor) : null;
    if (scope !== null && !scope.includes(problem.team)) {
      await audit(actor, req, "PROBLEM_ACTION_STATUS_UPDATE", "problem", String(problemId), "DENIED");
      return json(res, 403, { message: "不能更新未授权团队的改进行动" });
    }
    if (problem.status !== "行动中")
      return json(res, 409, { message: "只有行动中的问题可以更新行动状态" });
    const action = problem.actions.find(
      (candidate: any) => Number(candidate.id) === actionId,
    );
    if (!action) return json(res, 404, { message: "行动不存在" });
    const input = await body(req);
    if (input.status !== "已完成")
      return json(res, 400, { message: "当前只支持将行动标记为已完成" });
    if (!(await storage.updateProblemActionStatus(problemId, actionId, "已完成", scope)))
      return json(res, 409, { message: "改进行动已变更，请刷新后重试" });
    if (actor)
      await audit(
        actor,
        req,
        "PROBLEM_ACTION_STATUS_UPDATE",
        "action",
        String(actionId),
        "SUCCESS",
        { problemId, before: action.status, after: "已完成" },
      );
    return json(res, 200, { problems: await visibleProblems(actor) });
  }
  return json(res, 404, { message: "接口不存在" });
}

function staticFile(res: http.ServerResponse, pathname: string) {
  const target =
    pathname === "/"
      ? path.join(webDist, "index.html")
      : path.join(webDist, pathname);
  const safe = path.normalize(target);
  if (
    !safe.startsWith(webDist) ||
    !fs.existsSync(safe) ||
    fs.statSync(safe).isDirectory()
  ) {
    const fallback = path.join(webDist, "index.html");
    if (!fs.existsSync(fallback))
      return json(res, 404, { message: "前端尚未构建，请运行 npm run dev" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(fallback));
  }
  const ext = path.extname(safe),
    types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
    };
  res.writeHead(200, {
    "content-type": types[ext] ?? "application/octet-stream",
  });
  res.end(fs.readFileSync(safe));
}

await initializePostgres();
const stopDataSourceScheduler =
  storageKind === "postgresql" ? startDataSourceScheduler() : () => {};

const server = http
  .createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else staticFile(res, url.pathname);
    } catch (error) {
      console.error(error);
      json(res, 500, {
        message: error instanceof Error ? error.message : "未知错误",
      });
    }
  })
  .listen(port, host, () =>
    console.log(`效能运营平台已启动：http://${host}:${port}`),
  );

async function shutdown() {
  stopDataSourceScheduler();
  server.close();
  await closePostgres();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
