import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type {
  ProcessConfig,
  StageSummary,
} from "../../../packages/contracts/v01";
import { api } from "./api";
import {
  BaselinePanel,
  DefinitionView,
  ImportBatchPanel,
  ImprovementView,
  ReasonQueue,
} from "./Operations";

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

type View =
  | "dashboard"
  | "efficiency"
  | "effect"
  | "reasons"
  | "problems"
  | "batches"
  | "baseline"
  | "import"
  | "definitions"
  | "processSpaces"
  | "users"
  | "audit";
type State = {
  config: ProcessConfig;
  dashboard: any;
  operations: any;
  problems: any[];
};
type Filters = {
  from: string;
  to: string;
  teams: string[];
  priority: string;
  slaMode: "historical" | "current";
};

const fmtHours = (value: number | null) =>
  value === null ? "无数据" : `${value.toFixed(1)}h`;
const fmtRate = (value: number | null) =>
  value === null ? "无数据" : `${(value * 100).toFixed(1)}%`;

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [auth, setAuth] = useState<{
    ready: boolean;
    required: boolean;
    needsBootstrap: boolean;
    user: any | null;
  }>({ ready: false, required: false, needsBootstrap: false, user: null });
  const [filters, setFilters] = useState<Filters>({
    from: "",
    to: "",
    teams: [],
    priority: "",
    slaMode: "historical",
  });
  const load = async (next = filters) => {
    try {
      setError("");
      const params = new URLSearchParams();
      if (next.from) params.set("from", next.from);
      if (next.to) params.set("to", next.to);
      if (next.priority) params.set("priority", next.priority);
      if (next.slaMode === "current") params.set("slaMode", "current");
      next.teams.forEach((team) => params.append("team", team));
      const query = params.toString();
      setState(await api(`/api/state${query ? `?${query}` : ""}`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void (async () => {
      try {
        const status = await api<any>("/api/auth/status");
        if (!status.required) {
          setAuth({
            ready: true,
            required: false,
            needsBootstrap: false,
            user: null,
          });
          await load();
          return;
        }
        if (status.needsBootstrap) {
          setAuth({
            ready: true,
            required: true,
            needsBootstrap: true,
            user: null,
          });
          return;
        }
        try {
          const current = await api<any>("/api/auth/me");
          setAuth({
            ready: true,
            required: true,
            needsBootstrap: false,
            user: current.user,
          });
          await load();
        } catch {
          setAuth({
            ready: true,
            required: true,
            needsBootstrap: false,
            user: null,
          });
        }
      } catch (e) {
        setError((e as Error).message);
        setAuth((value) => ({ ...value, ready: true }));
      }
    })();
  }, []);
  const titles: Record<View, string> = {
    dashboard: "软件开发流程运营看板",
    efficiency: "效率改进分析",
    effect: "效果改进分析",
    reasons: "原因待填",
    problems: "持续改进",
    batches: "导入批次",
    baseline: "SLA 与基线配置",
    import: "数据接入与流程配置",
    definitions: "口径说明",
    processSpaces: "流程空间",
    users: "账号与权限",
    audit: "审计日志",
  };
  const initialized = Boolean(state?.dashboard.lastImport);
  const canConfigure =
    !auth.user || ["SYSTEM_ADMIN", "OPERATIONS_LEAD"].includes(auth.user.role);
  const reset = async () => {
    if (
      !window.confirm(
        "确认恢复到初始化状态？当前导入数据、原因、问题、行动和复核记录都会被清除。",
      )
    )
      return;
    await api("/api/reset", {
      method: "POST",
      body: JSON.stringify({ confirm: "RESET_DEMO" }),
    });
    setFilters({
      from: "",
      to: "",
      teams: [],
      priority: "",
      slaMode: "historical",
    });
    setView("import");
    await load({ from: "", to: "", teams: [], priority: "" });
  };

  if (!auth.ready)
    return (
      <div className="auth-shell">
        <div className="loading">正在检查运行环境…</div>
      </div>
    );
  if (auth.required && !auth.user)
    return (
      <AuthScreen
        bootstrap={auth.needsBootstrap}
        onReady={async (user) => {
          setAuth({ ready: true, required: true, needsBootstrap: false, user });
          await load();
        }}
      />
    );
  if (auth.user?.mustChangePassword)
    return (
      <PasswordChange
        onChanged={() =>
          setAuth((value) => ({
            ...value,
            user: { ...value.user, mustChangePassword: false },
          }))
        }
      />
    );

  return (
    <div className="app-shell">
      <aside>
        <div className="brand">
          <span className="brand-mark">效</span>
          <div>
            <b>企业效能运营</b>
          </div>
        </div>
        <nav>
          {state && !initialized ? (
            <>
              <span className="nav-section">开始使用</span>
              <button className="active">上传数据</button>
            </>
          ) : state ? (
            <>
              <span className="nav-section">观测</span>
              <button
                className={view === "dashboard" ? "active" : ""}
                onClick={() => setView("dashboard")}
              >
                运营看板
              </button>
              <span className="nav-section">诊断与改进</span>
              <button
                className={view === "reasons" ? "active" : ""}
                onClick={() => setView("reasons")}
              >
                原因待填
              </button>
              <button
                className={view === "efficiency" ? "active" : ""}
                onClick={() => setView("efficiency")}
              >
                效率改进分析
              </button>
              <button
                className={view === "effect" ? "active" : ""}
                onClick={() => setView("effect")}
              >
                效果改进分析
              </button>
              <button
                className={view === "problems" ? "active" : ""}
                onClick={() => setView("problems")}
              >
                持续改进
              </button>
              {canConfigure && (
                <>
                  <span className="nav-section">配置</span>
                  {import.meta.env.DEV && (
                    <button
                      className={view === "processSpaces" ? "active" : ""}
                      onClick={() => setView("processSpaces")}
                    >
                      流程空间
                    </button>
                  )}
                  <button
                    className={view === "batches" ? "active" : ""}
                    onClick={() => setView("batches")}
                  >
                    导入批次
                  </button>
                  <button
                    className={view === "import" ? "active" : ""}
                    onClick={() => setView("import")}
                  >
                    数据与流程
                  </button>
                  <button
                    className={view === "baseline" ? "active" : ""}
                    onClick={() => setView("baseline")}
                  >
                    基线配置
                  </button>
                </>
              )}
              {auth.user?.role === "SYSTEM_ADMIN" && (
                <>
                  <span className="nav-section">系统管理</span>
                  <button
                    className={view === "users" ? "active" : ""}
                    onClick={() => setView("users")}
                  >
                    账号与权限
                  </button>
                  <button
                    className={view === "audit" ? "active" : ""}
                    onClick={() => setView("audit")}
                  >
                    审计日志
                  </button>
                </>
              )}
              <button
                className={view === "definitions" ? "active" : ""}
                onClick={() => setView("definitions")}
              >
                口径说明
              </button>
            </>
          ) : null}
        </nav>
        {initialized && (
          <div className="role">
            <span>当前视角</span>
            <strong>{auth.user?.displayName ?? "效能运营负责人"}</strong>
            <small>{auth.user?.role ?? "SQLite 演示视角"}</small>
            {auth.user && (
              <button
                onClick={async () => {
                  await api("/api/auth/logout", { method: "POST", body: "{}" });
                  location.reload();
                }}
              >
                退出登录
              </button>
            )}
          </div>
        )}
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">PROCESS OPERATIONS</p>
            <h1>{state && !initialized ? "初始化运营流程" : titles[view]}</h1>
          </div>
          <span className="status-dot">本机运行</span>
        </header>
        {error && <div className="alert error">{error}</div>}
        {!state ? (
          <div className="loading">正在加载…</div>
        ) : !initialized ? (
          <Initialization
            config={state.config}
            onImported={async () => {
              await load();
              setView("dashboard");
            }}
          />
        ) : view === "dashboard" ? (
          <Dashboard
            state={state}
            filters={filters}
            setFilters={setFilters}
            reload={load}
            goImport={() => setView("import")}
          />
        ) : view === "reasons" ? (
          <ReasonQueue state={state} reload={load} />
        ) : view === "efficiency" ? (
          <ImprovementView state={state} reload={load} kind="efficiency" />
        ) : view === "effect" ? (
          <ImprovementView state={state} reload={load} kind="effect" />
        ) : view === "baseline" ? (
          <BaselinePanel state={state} reload={load} />
        ) : view === "batches" ? (
          <ImportBatchPanel state={state} reload={load} />
        ) : view === "definitions" ? (
          <DefinitionView />
        ) : view === "import" ? (
          <ImportPanel
            initial={state.config}
            onReset={auth.required ? undefined : reset}
            onImported={async () => {
              await load();
              setView("dashboard");
            }}
          />
        ) : view === "users" ? (
          <UsersPanel />
        ) : import.meta.env.DEV && view === "processSpaces" ? (
          <ProcessSpacesPanel />
        ) : view === "audit" ? (
          <AuditPanel />
        ) : (
          <Problems state={state} reload={load} />
        )}
      </main>
    </div>
  );
}

const auditActionNames: Record<string, string> = {
  PROCESS_SPACE_CREATE: "创建流程空间",
  PROCESS_SPACE_STATUS_UPDATE: "启用/停用流程空间",
  AUTH_BOOTSTRAP_ADMIN: "初始化管理员",
  AUTH_LOGIN: "登录",
  AUTH_LOGOUT: "退出登录",
  AUTH_PASSWORD_CHANGE: "修改密码",
  USER_CREATE: "创建账号",
  USER_ACTIVE_UPDATE: "启用/禁用账号",
  USER_PASSWORD_RESET: "重置密码",
  IMPORT_PREPARE: "准备导入批次",
  IMPORT_PUBLISH: "发布导入批次",
  IMPORT_REJECT: "放弃导入批次",
  CONFIG_UPDATE: "更新流程配置",
  CONFIG_DRAFT_CREATE: "创建配置草稿",
  CONFIG_PUBLISH: "发布配置版本",
  BASELINE_UPDATE: "更新运营基线",
  OPERATIONAL_REASON_SAVE: "保存运营原因",
  PROBLEM_CREATE: "创建改进问题",
  PROBLEM_STATUS_UPDATE: "更新问题状态",
  PROBLEM_ACTION_STATUS_UPDATE: "更新行动状态",
  DEMO_RESET: "重置测试数据",
  AUDIT_READ: "查看审计日志",
  BACKUP_CREATE: "创建数据库备份",
  RESTORE_COMPLETE: "完成数据库恢复",
};

function ProcessSpacesPanel() {
  const [spaces, setSpaces] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    code: "",
    description: "",
    owner: "",
  });
  const loadSpaces = async () => {
    try {
      setError("");
      setSpaces((await api<any>("/api/process-spaces")).processSpaces);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void loadSpaces();
  }, []);
  return (
    <div className="users-layout">
      <section className="panel">
        <h2>创建流程空间</h2>
        <p>
          每个空间将拥有独立的数据源、流程配置、SLA
          和看板。当前阶段先建立空间目录，既有数据继续归属于默认流程。
        </p>
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              await api("/api/process-spaces", {
                method: "POST",
                body: JSON.stringify(form),
              });
              setForm({ name: "", code: "", description: "", owner: "" });
              await loadSpaces();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            空间名称
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：研发交付流程"
              required
            />
          </label>
          <label>
            空间编码
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="例如：rd-delivery"
              pattern="[a-z][a-z0-9-]{1,31}"
              required
            />
          </label>
          <label>
            负责人
            <input
              value={form.owner}
              onChange={(e) => setForm({ ...form, owner: e.target.value })}
              placeholder="流程负责人"
            />
          </label>
          <label className="wide">
            用途说明
            <input
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="这个空间管理哪一类业务流程"
            />
          </label>
          <button className="primary">创建流程空间</button>
        </form>
        {error && <div className="alert error">{error}</div>}
      </section>
      <section className="panel">
        <h2>流程空间目录</h2>
        <p>停用不会删除空间或历史数据；默认流程用于兼容 V0.3，不能停用。</p>
        <div className="user-list">
          {spaces.map((space) => (
            <article key={space.id} className="user-row">
              <div>
                <strong>{space.name}</strong>
                <small>
                  {space.code} · {space.owner || "未指定负责人"}
                  {space.is_default ? " · 默认空间" : ""}
                </small>
                {space.description && <small>{space.description}</small>}
              </div>
              <div>
                <span
                  className={
                    space.status === "ACTIVE" ? "status-pill ok" : "status-pill"
                  }
                >
                  {space.status === "ACTIVE" ? "已启用" : "已停用"}
                </span>
                {!space.is_default && (
                  <button
                    onClick={async () => {
                      await api(`/api/process-spaces/${space.id}/status`, {
                        method: "POST",
                        body: JSON.stringify({
                          status:
                            space.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                        }),
                      });
                      await loadSpaces();
                    }}
                  >
                    {space.status === "ACTIVE" ? "停用" : "启用"}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function AuditPanel() {
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({
    user: "",
    action: "",
    result: "",
    from: "",
    to: "",
  });
  useEffect(() => {
    void api<any>("/api/audit-events")
      .then((value) => setEvents(value.events))
      .catch((reason) => setError((reason as Error).message));
  }, []);
  const actions = [...new Set(events.map((event) => event.action))].sort();
  const users = [
    ...new Set(events.map((event) => event.username).filter(Boolean)),
  ].sort();
  const visible = events.filter((event) => {
    const day = String(event.occurred_at).slice(0, 10);
    return (
      (!filters.user || event.username === filters.user) &&
      (!filters.action || event.action === filters.action) &&
      (!filters.result || event.result === filters.result) &&
      (!filters.from || day >= filters.from) &&
      (!filters.to || day <= filters.to)
    );
  });
  return (
    <section className="panel audit-panel">
      <div>
        <h2>审计日志</h2>
        <p>
          只读展示最近 200 条关键操作；密码、会话令牌和原始业务行不会进入详情。
        </p>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="audit-filters">
        <label>
          开始日期
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </label>
        <label>
          用户
          <select
            value={filters.user}
            onChange={(e) => setFilters({ ...filters, user: e.target.value })}
          >
            <option value="">全部用户</option>
            {users.map((user) => (
              <option key={user}>{user}</option>
            ))}
          </select>
        </label>
        <label>
          操作
          <select
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
          >
            <option value="">全部操作</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {auditActionNames[action] ?? action}
              </option>
            ))}
          </select>
        </label>
        <label>
          结果
          <select
            value={filters.result}
            onChange={(e) => setFilters({ ...filters, result: e.target.value })}
          >
            <option value="">全部结果</option>
            <option value="SUCCESS">成功</option>
            <option value="DENIED">已拒绝</option>
            <option value="FAILED">失败</option>
          </select>
        </label>
      </div>
      <p className="muted">
        当前显示 {visible.length} / {events.length} 条
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>用户</th>
              <th>操作</th>
              <th>对象</th>
              <th>结果</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.occurred_at).toLocaleString()}</td>
                <td>{event.username ?? "系统/匿名"}</td>
                <td>{auditActionNames[event.action] ?? event.action}</td>
                <td>
                  {event.object_type}
                  {event.object_id ? ` #${event.object_id}` : ""}
                </td>
                <td>
                  <span
                    className={`audit-result ${String(event.result).toLowerCase()}`}
                  >
                    {event.result === "SUCCESS"
                      ? "成功"
                      : event.result === "DENIED"
                        ? "已拒绝"
                        : "失败"}
                  </span>
                </td>
                <td>
                  <code>
                    {Object.keys(event.details_json ?? {}).length
                      ? JSON.stringify(event.details_json)
                      : "—"}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visible.length && (
        <div className="empty-small">
          <b>没有符合条件的审计记录</b>
        </div>
      )}
    </section>
  );
}

function PasswordChange({ onChanged }: { onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="auth-shell">
      <form
        className="auth-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await api("/api/auth/change-password", {
              method: "POST",
              body: JSON.stringify({ currentPassword, newPassword }),
            });
            onChanged();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <span className="brand-mark">效</span>
        <p className="eyebrow">SECURITY REQUIRED</p>
        <h1>请先修改临时密码</h1>
        <p>修改成功后才能进入平台，其他已登录会话也会被撤销。</p>
        {error && <div className="alert error">{error}</div>}
        <label>
          当前临时密码
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </label>
        <small>至少 12 位，同时包含字母和数字。</small>
        <button className="primary">修改密码并进入</button>
      </form>
    </div>
  );
}

const roleNames: Record<string, string> = {
  SYSTEM_ADMIN: "系统管理员",
  OPERATIONS_LEAD: "效能运营负责人",
  TEAM_LEAD: "团队负责人",
  EXECUTOR: "执行人员",
  VIEWER: "只读查看者",
};

function UsersPanel() {
  const [users, setUsers] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "VIEWER",
    teams: "",
  });
  const loadUsers = async () => {
    try {
      setUsers((await api<any>("/api/users")).users);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void loadUsers();
  }, []);
  return (
    <div className="users-layout">
      <section className="panel">
        <h2>创建本地账号</h2>
        <p>团队范围用逗号分隔；管理员和效能运营负责人拥有全组织范围。</p>
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              await api("/api/users", {
                method: "POST",
                body: JSON.stringify({
                  ...form,
                  teams: form.teams
                    .split(/[,，]/)
                    .map((value) => value.trim())
                    .filter(Boolean),
                }),
              });
              setForm({
                username: "",
                displayName: "",
                password: "",
                role: "VIEWER",
                teams: "",
              });
              await loadUsers();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            用户名
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
            />
          </label>
          <label>
            显示名称
            <input
              value={form.displayName}
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
              required
            />
          </label>
          <label>
            临时密码
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
          </label>
          <label>
            角色
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {Object.entries(roleNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="wide">
            授权团队
            <input
              placeholder="例如：Team A, Team B"
              value={form.teams}
              onChange={(e) => setForm({ ...form, teams: e.target.value })}
            />
          </label>
          <button className="primary">创建账号</button>
        </form>
        {error && <div className="alert error">{error}</div>}
      </section>
      <section className="panel">
        <h2>现有账号</h2>
        <div className="user-list">
          {users.map((user) => (
            <article key={user.id} className="user-row">
              <div>
                <strong>{user.display_name}</strong>
                <small>
                  @{user.username} · {roleNames[user.role]} ·{" "}
                  {user.teams.length ? user.teams.join("、") : "全局/未分配"}
                </small>
              </div>
              <div>
                <span
                  className={user.active ? "status-pill ok" : "status-pill"}
                >
                  {user.active
                    ? user.must_change_password
                      ? "待首次改密"
                      : "正常"
                    : "已禁用"}
                </span>
                <button
                  onClick={async () => {
                    await api(`/api/users/${user.id}/active`, {
                      method: "POST",
                      body: JSON.stringify({ active: !user.active }),
                    });
                    await loadUsers();
                  }}
                >
                  {user.active ? "禁用" : "启用"}
                </button>
                <button
                  onClick={async () => {
                    const password = window.prompt(
                      "输入新的临时密码（至少 12 位，包含字母和数字）",
                    );
                    if (!password) return;
                    await api(`/api/users/${user.id}/reset-password`, {
                      method: "POST",
                      body: JSON.stringify({ password }),
                    });
                    await loadUsers();
                  }}
                >
                  重置密码
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function AuthScreen({
  bootstrap,
  onReady,
}: {
  bootstrap: boolean;
  onReady: (user: any) => void;
}) {
  const [username, setUsername] = useState(bootstrap ? "admin" : "");
  const [displayName, setDisplayName] = useState("系统管理员");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (bootstrap)
        await api("/api/auth/bootstrap", {
          method: "POST",
          body: JSON.stringify({ username, displayName, password, token: token.trim() }),
        });
      const result = await api<any>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      onReady(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <span className="brand-mark">效</span>
        <p className="eyebrow">ENTERPRISE EFFECTIVENESS</p>
        <h1>{bootstrap ? "创建首个管理员" : "登录效能运营平台"}</h1>
        <p>
          {bootstrap
            ? "这是一次性初始化。创建后，其他账号由管理员统一管理。"
            : "使用本地账号进入当前部署实例。"}
        </p>
        {error && <div className="alert error">{error}</div>}
        <label>
          用户名
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        {bootstrap && (
          <>
            <label>
              显示名称
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </label>
            <label>
              部署初始化令牌
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
            </label>
          </>
        )}
        <label>
          密码
          <input
            type="password"
            autoComplete={bootstrap ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {bootstrap && <small>至少 12 位，同时包含字母和数字。</small>}
        <button className="primary" disabled={busy}>
          {busy ? "正在处理…" : bootstrap ? "创建并登录" : "登录"}
        </button>
      </form>
    </div>
  );
}

function Initialization({
  config,
  onImported,
}: {
  config: ProcessConfig;
  onImported: () => void;
}) {
  return (
    <div className="initialization">
      <section className="initialization-intro">
        <span>01</span>
        <div>
          <h2>先导入团队的流程数据</h2>
          <p>
            当前还没有运营数据。上传 UTF-8 CSV
            并确认字段与环节映射后，系统才会生成运营看板和改进工作台。
          </p>
        </div>
      </section>
      <ImportPanel initial={config} onImported={onImported} />
    </div>
  );
}

function Dashboard({ state, filters, setFilters, reload, goImport }: any) {
  const data = state.dashboard;
  const [stage, setStage] = useState<any>(null),
    [ticket, setTicket] = useState<any>(null),
    [stageTab, setStageTab] = useState<
      "active" | "active_overdue" | "history" | "all"
    >("active"),
    [matrixMetric, setMatrixMetric] = useState<"p90" | "sla">("p90");
  if (!data.lastImport) return <EmptyState onClick={goImport} />;
  const summary = data.summary;
  const comparisonPriority = (filters.priority || "P1") as "P0" | "P1" | "P2";
  const slaRateTarget =
    state.operations.baselines.slaAchievementTarget[comparisonPriority] ?? 0.8;
  const openStage = async (item: StageSummary, team?: string) => {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.priority) params.set("priority", filters.priority);
    if (team) params.set("team", team);
    else filters.teams.forEach((value: string) => params.append("team", value));
    if (filters.slaMode === "current") params.set("slaMode", "current");
    const query = params.toString();
    setStageTab("active");
    setStage({
      ...item,
      team,
      rows: await api(`/api/stages/${item.id}${query ? `?${query}` : ""}`),
    });
  };
  const toggleTeam = (team: string) =>
    setFilters({
      ...filters,
      teams: filters.teams.includes(team)
        ? filters.teams.filter((item: string) => item !== team)
        : [...filters.teams, team],
    });
  return (
    <>
      {data.calculationMode === "current-config-simulation" && (
        <section className="simulation-banner">
          <strong>模拟视图</strong>
          <span>
            当前页面使用最新 SLA
            重新判断历史观测，仅用于影响评估；正式历史数据没有被修改。
          </span>
        </section>
      )}
      <section className="toolbar card">
        <label>
          开始日期
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </label>
        <div className="filter-field">
          <span>团队（可多选）</span>
          <details className="multi-select">
            <summary>
              {filters.teams.length
                ? `已选 ${filters.teams.length} 个团队`
                : "全部团队"}
            </summary>
            <div className="multi-options">
              <button
                type="button"
                onClick={() => setFilters({ ...filters, teams: [] })}
              >
                全部团队
              </button>
              {data.teams.map((team: string) => (
                <label key={team}>
                  <input
                    type="checkbox"
                    checked={filters.teams.includes(team)}
                    onChange={() => toggleTeam(team)}
                  />
                  {team}
                </label>
              ))}
            </div>
          </details>
        </div>
        <label>
          优先级
          <select
            value={filters.priority}
            onChange={(e) =>
              setFilters({ ...filters, priority: e.target.value })
            }
          >
            <option value="">全部</option>
            <option>P0</option>
            <option>P1</option>
            <option>P2</option>
          </select>
        </label>
        <label>
          SLA 口径
          <select
            value={filters.slaMode}
            onChange={(e) =>
              setFilters({
                ...filters,
                slaMode: e.target.value as "historical" | "current",
              })
            }
          >
            <option value="historical">历史生效配置（正式）</option>
            <option value="current">当前配置重算（模拟）</option>
          </select>
        </label>
        <button className="primary compact" onClick={() => reload(filters)}>
          应用筛选
        </button>
        <div className="import-meta">
          最近导入
          <br />
          <b>{new Date(data.lastImport.imported_at).toLocaleString()}</b>
        </div>
      </section>
      <section className="kpis">
        <Kpi
          label="单据总数"
          value={String(summary.ticketCount)}
          hint={`${summary.completedTicketCount} 条已完成`}
        />
        <Kpi
          label="平均端到端周期"
          value={fmtHours(summary.meanLeadTimeHours)}
          hint="自然小时"
        />
        <Kpi
          label="P90 端到端周期"
          value={fmtHours(summary.p90LeadTimeHours)}
          hint="长尾观察"
          tone="warn"
        />
        <Kpi
          label="环节超期率"
          value={fmtRate(summary.stageOverdueRate)}
          hint="已完成环节实例"
          tone="warn"
        />
        <Kpi
          label="发布成功率"
          value={fmtRate(summary.releaseSuccessRate)}
          hint="效果护栏"
          tone="good"
        />
        <Kpi
          label="最近批次数据有效率"
          value={fmtRate(summary.dataValidRate)}
          hint={data.lastImport.total_rows === undefined
            ? "仅展示全局批次口径"
            : `${data.lastImport.valid_rows}/${data.lastImport.total_rows} 条`}
        />
      </section>
      <section className="card team-matrix-card">
        <SectionTitle
          title="团队 × 流程环节"
          desc="纵向查看各团队，横向对比各环节；点击单元格可下钻到该团队的单据"
        />
        <div className="matrix-toolbar">
          <span>展示数据</span>
          <div className="seg-control">
            <button
              className={matrixMetric === "p90" ? "active" : ""}
              onClick={() => setMatrixMetric("p90")}
            >
              P90 时长
            </button>
            <button
              className={matrixMetric === "sla" ? "active" : ""}
              onClick={() => setMatrixMetric("sla")}
            >
              SLA 达标率
            </button>
          </div>
        </div>
        <div className="team-matrix-wrap">
          <div className="team-matrix">
            <div className="matrix-corner">团队</div>
            {data.stages.map((item: StageSummary) => (
              <div className={`matrix-stage-head ${item.type}`} key={item.id}>
                {item.name}
              </div>
            ))}
            {data.teamMatrix.map((row: any) => (
              <div className="matrix-row" key={row.team}>
                <div className="matrix-team">
                  <strong>{row.team}</strong>
                  <span>{row.ticketCount} 条单据</span>
                </div>
                {row.stages.map((item: StageSummary) => {
                  const baseline = item.comparisonSlaHours;
                  const actual =
                    matrixMetric === "p90"
                      ? item.p90Hours
                      : item.slaAchievementRate;
                  const target =
                    matrixMetric === "p90" ? baseline : slaRateTarget;
                  const achieved =
                    actual === null || target === null
                      ? null
                      : matrixMetric === "p90"
                        ? actual <= target
                        : actual >= target;

                  return (
                    <button
                      key={item.id}
                      className={`matrix-cell ${achieved === true ? "good" : achieved === false ? "danger" : "neutral"}`}
                      onClick={() => openStage(item, row.team)}
                    >
                      <span className="matrix-actual-label">
                        {matrixMetric === "p90" ? "实际 / 基线" : "实际 / 目标"}
                      </span>
                      <b>
                        {matrixMetric === "p90"
                          ? `${fmtHours(item.p90Hours)} / ${fmtHours(baseline)}`
                          : `${fmtRate(item.slaAchievementRate)} / ${fmtRate(slaRateTarget)}`}
                      </b>
                      <small>
                        在途 {item.activeCount} · 在途超期{" "}
                        {item.activeOverdueCount} / 历史超期{" "}
                        {item.completedOverdueCount}
                      </small>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="grid-two">
        <div className="card">
          <SectionTitle
            title="流程效能带"
            desc="处理与等待被同等观察；红色表示触发异常规则"
          />
          <div className="process-strip">
            {data.stages.map((s: StageSummary, i: number) => (
              <button
                key={s.id}
                onClick={() => openStage(s)}
                className={`${s.type} ${s.abnormal ? "danger" : ""}`}
              >
                <small>{String(i + 1).padStart(2, "0")}</small>
                <strong>{s.name}</strong>
                <span>P90 {fmtHours(s.p90Hours)}</span>
                <span>在途 {s.activeCount}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <SectionTitle
            title="环节 P90 对比"
            desc="点击下方表格可下钻到具体单据"
          />
          <StageChart stages={data.stages} />
        </div>
      </section>
      <section className="card">
        <SectionTitle
          title="环节效能明细"
          desc="样本量、长尾和超期信息同时展示"
        />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>环节</th>
                <th>类型</th>
                <th>完成/在途</th>
                <th>平均</th>
                <th>P50</th>
                <th>P90</th>
                <th>P1 SLA</th>
                <th>完成超期率</th>
                <th>在途超期</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {data.stages.map((s: StageSummary) => (
                <tr key={s.id} onClick={() => openStage(s)}>
                  <td>
                    <b>{s.name}</b>
                  </td>
                  <td>
                    <span className={`pill ${s.type}`}>
                      {s.type === "waiting" ? "等待" : "处理"}
                    </span>
                  </td>
                  <td>
                    {s.completedCount} / {s.activeCount}
                  </td>
                  <td>{fmtHours(s.meanHours)}</td>
                  <td>{fmtHours(s.p50Hours)}</td>
                  <td>{fmtHours(s.p90Hours)}</td>
                  <td>{fmtHours(s.p1SlaHours)}</td>
                  <td>{fmtRate(s.completedOverdueRate)}</td>
                  <td>{s.activeOverdueCount}</td>
                  <td>
                    <span className={`pill ${s.abnormal ? "bad" : "ok"}`}>
                      {s.abnormal ? "需关注" : "正常"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {stage && (
        <Modal
          title={`${stage.team ? `${stage.team} · ` : ""}${stage.name} · 单据下钻`}
          onClose={() => setStage(null)}
        >
          <div className="modal-summary">
            <span>
              完成样本 <b>{stage.completedCount}</b>
            </span>
            <span>
              在途单据 <b>{stage.activeCount}</b>
            </span>
            <span>
              P90 <b>{fmtHours(stage.p90Hours)}</b>
            </span>
            <span>
              超期率 <b>{fmtRate(stage.completedOverdueRate)}</b>
            </span>
          </div>
          <div className="tabs compact-tabs modal-tabs">
            <button
              className={stageTab === "active" ? "active" : ""}
              onClick={() => setStageTab("active")}
            >
              在途（{stage.activeCount}）
            </button>
            <button
              className={stageTab === "active_overdue" ? "active" : ""}
              onClick={() => setStageTab("active_overdue")}
            >
              在途超期（{stage.activeOverdueCount}）
            </button>
            <button
              className={stageTab === "history" ? "active" : ""}
              onClick={() => setStageTab("history")}
            >
              历史超期
            </button>
            <button
              className={stageTab === "all" ? "active" : ""}
              onClick={() => setStageTab("all")}
            >
              全部
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>单号</th>
                  <th>标题</th>
                  <th>团队</th>
                  <th>优先级</th>
                  <th>耗时</th>
                  <th>SLA</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {stage.rows
                  .filter((r: any) =>
                    stageTab === "all"
                      ? true
                      : stageTab === "active"
                        ? r.state === "active"
                        : stageTab === "active_overdue"
                          ? r.state === "active" && r.overdue
                          : r.state === "completed" && r.overdue,
                  )
                  .map((r: any) => (
                    <tr
                      key={r.id}
                      onClick={async () =>
                        setTicket(
                          await api(
                            `/api/work-items/${r.ticket_id}${filters.slaMode === "current" ? "?slaMode=current" : ""}`,
                          ),
                        )
                      }
                    >
                      <td className="link">{r.ticket_id}</td>
                      <td>{r.title}</td>
                      <td>{r.team}</td>
                      <td>{r.priority}</td>
                      <td>{fmtHours(r.hours)}</td>
                      <td>{fmtHours(r.sla_hours)}</td>
                      <td>
                        <span className={`pill ${r.overdue ? "bad" : "ok"}`}>
                          {r.state === "active"
                            ? "在途"
                            : r.overdue
                              ? "超期"
                              : "完成"}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
      {ticket && (
        <TicketModal ticket={ticket} onClose={() => setTicket(null)} />
      )}
    </>
  );
}

function ImportPanel({
  initial,
  onImported,
  onReset,
}: {
  initial: ProcessConfig;
  onImported: () => void;
  onReset?: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<ProcessConfig>(structuredClone(initial)),
    [csv, setCsv] = useState(""),
    [filename, setFilename] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [result, setResult] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const fileChange = async (file?: File) => {
    if (!file) return;
    const content = await file.text();
    setCsv(content);
    setFilename(file.name);
    setPreview(
      await api("/api/import/preview", {
        method: "POST",
        body: JSON.stringify({ csv: content }),
      }),
    );
  };
  const updateStage = (index: number, key: string, value: any) =>
    setConfig((c) => ({
      ...c,
      stages: c.stages.map((s, i) =>
        i === index
          ? key.startsWith("sla.")
            ? {
                ...s,
                slaHours: { ...s.slaHours, [key.split(".")[1]]: Number(value) },
              }
            : { ...s, [key]: value }
          : s,
      ),
    }));
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const value = await api<any>("/api/import/prepare", {
        method: "POST",
        body: JSON.stringify({ filename, csv, config }),
      });
      setResult(value);
    } catch (e: any) {
      setError(e.message);
      setResult(e.details);
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/import-batches/${result.batchId}/publish`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await onImported();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const headers = preview?.headers ?? [];
  return (
    <div className="stack">
      <DatabaseSourcePanel initial={initial} onPublished={onImported} />
      <section className="card">
        <SectionTitle
          title="备用导入：上传数据快照"
          desc="CSV 仅用于验证、过渡或应急；正式运行请使用上方数据库连接"
        />
        <div className="dropzone">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => fileChange(e.target.files?.[0])}
          />
          <button
            type="button"
            className="primary"
            onClick={() => fileInputRef.current?.click()}
          >
            选择 CSV 文件
          </button>
          <div className="selected-file">
            <b>{filename || "尚未选择文件"}</b>
            <span>
              {filename ? "已读取，请确认预览后上传" : "支持 UTF-8 CSV"}
            </span>
          </div>
          <small>手工上传 · 不自动刷新</small>
        </div>
        {preview && (
          <div className="upload-ready">
            <div className="preview-meta">
              <span>
                字段 <b>{headers.length}</b>
              </span>
              <span>
                记录 <b>{preview.rowCount}</b>
              </span>
              <span>
                解析错误 <b>{preview.parseErrors.length}</b>
              </span>
            </div>
            <button
              className="primary upload-now"
              disabled={busy || preview.parseErrors.length > 0}
              onClick={submit}
            >
              {busy ? "正在校验…" : "生成待发布批次"}
            </button>
          </div>
        )}
      </section>
      {preview && (
        <>
          <section className="card">
            <SectionTitle
              title="2. 基础字段映射"
              desc="选择每个业务语义对应的来源字段"
            />
            <div className="mapping-grid">
              {(
                [
                  ["业务主键", "keyField"],
                  ["标题", "titleField"],
                  ["团队", "teamField"],
                  ["优先级", "priorityField"],
                  ["当前状态", "statusField"],
                  ["发布结果", "outcomeField"],
                ] as const
              ).map(([label, key]) => (
                <label key={key}>
                  {label}
                  <select
                    value={config[key]}
                    onChange={(e) =>
                      setConfig({ ...config, [key]: e.target.value })
                    }
                  >
                    {headers.map((h: string) => (
                      <option key={h}>{h}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </section>
          <section className="card">
            <SectionTitle
              title="3. 环节字段与 SLA"
              desc="起止字段来自数据源；平台只校验和计算，不推断返工"
            />
            <div className="table-wrap">
              <table className="config-table">
                <thead>
                  <tr>
                    <th>顺序</th>
                    <th>环节</th>
                    <th>类型</th>
                    <th>开始字段</th>
                    <th>结束字段</th>
                    <th>P0</th>
                    <th>P1</th>
                    <th>P2</th>
                  </tr>
                </thead>
                <tbody>
                  {config.stages.map((s, i) => (
                    <tr key={s.id}>
                      <td>{i + 1}</td>
                      <td>
                        <input
                          value={s.name}
                          onChange={(e) =>
                            updateStage(i, "name", e.target.value)
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={s.type}
                          onChange={(e) =>
                            updateStage(i, "type", e.target.value)
                          }
                        >
                          <option value="processing">处理</option>
                          <option value="waiting">等待</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={s.startField}
                          onChange={(e) =>
                            updateStage(i, "startField", e.target.value)
                          }
                        >
                          {headers.map((h: string) => (
                            <option key={h}>{h}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={s.endField}
                          onChange={(e) =>
                            updateStage(i, "endField", e.target.value)
                          }
                        >
                          {headers.map((h: string) => (
                            <option key={h}>{h}</option>
                          ))}
                        </select>
                      </td>
                      {(["P0", "P1", "P2"] as const).map((p) => (
                        <td key={p}>
                          <input
                            type="number"
                            min="0.1"
                            step="0.5"
                            value={s.slaHours[p]}
                            onChange={(e) =>
                              updateStage(i, `sla.${p}`, e.target.value)
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="action-bar">
            <div>
              {error && <span className="error-text">{error}</span>}
              {result?.issues?.length ? (
                <span>{result.issues.length} 条数据问题</span>
              ) : null}
            </div>
            <button className="primary" disabled={busy} onClick={submit}>
              {busy ? "正在校验…" : "生成待发布批次"}
            </button>
          </section>
          {result?.batchId && (
            <section className="card success-card">
              <h3>批次已准备，尚未影响正式看板</h3>
              <p>
                新增 {result.newRows} 条，更新 {result.updatedRows} 条，无变化{" "}
                {result.unchangedRows} 条，错误 {result.errorRows} 条。
              </p>
              <button className="primary" disabled={busy} onClick={publish}>
                {busy ? "正在发布…" : "确认发布并生成看板"}
              </button>
            </section>
          )}
        </>
      )}
      {onReset && (
        <section className="card reset-card">
          <div>
            <h3>重新测试初始化流程</h3>
            <p>清除当前 Demo 数据和运营记录，回到首次上传前的状态。</p>
          </div>
          <button className="danger-action" onClick={onReset}>
            重置为初始化状态
          </button>
        </section>
      )}
    </div>
  );
}

type DataSourceSummary = {
  id: number;
  name: string;
  status: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl_mode: string;
  has_secret: boolean;
  latest_sync_run_id?: number;
  latest_sync_status?: string;
  latest_sync_run_type?: "FULL" | "INCREMENTAL";
  latest_rows_read?: number;
  latest_rows_rejected?: number;
  schedule_json?: {
    enabled: boolean;
    frequency: "EVERY_15_MINUTES" | "HOURLY" | "DAILY" | "WEEKLY";
    hour: number;
    minute: number;
    dayOfWeek: number;
    timezone?: string;
    nextRunAt?: string | null;
  };
};

type SyncRunSummary = {
  id: number;
  data_source_name: string;
  run_type: "FULL" | "INCREMENTAL";
  trigger_type: "MANUAL" | "SCHEDULED" | "RETRY";
  status: string;
  started_at?: string;
  finished_at?: string;
  rows_read: number;
  rows_new: number;
  rows_updated: number;
  rows_unchanged: number;
  rows_rejected: number;
  attempt_no: number;
  error_summary?: string;
};

function DatabaseSourcePanel({
  initial,
  onPublished,
}: {
  initial: ProcessConfig;
  onPublished: () => void;
}) {
  const [sources, setSources] = useState<DataSourceSummary[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRunSummary[]>([]);
  const [syncDetails, setSyncDetails] = useState<any>(null);
  const [form, setForm] = useState({
    name: "",
    host: "127.0.0.1",
    port: 5432,
    databaseName: "",
    username: "",
    password: "",
    sslMode: "VERIFY_FULL",
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [objects, setObjects] = useState<any[]>([]);
  const [selectedObject, setSelectedObject] = useState("");
  const [objectPreview, setObjectPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<ProcessConfig>(
    structuredClone(initial),
  );
  const [updatedAtField, setUpdatedAtField] = useState("updated_at");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(false);

  const loadSources = async () => {
    try {
      const [sourceValue, runValue] = await Promise.all([
        api<{ dataSources: DataSourceSummary[] }>("/api/data-sources"),
        api<{ syncRuns: SyncRunSummary[] }>("/api/sync-runs"),
      ]);
      setSources(sourceValue.dataSources);
      setSyncRuns(runValue.syncRuns);
      if (!sourceValue.dataSources.length) setShowConnectionForm(true);
      if (!selectedId && sourceValue.dataSources.length)
        setSelectedId(sourceValue.dataSources[0].id);
    } catch (e: any) {
      if (e.status !== 403) setError(e.message);
    }
  };

  useEffect(() => {
    void loadSources();
  }, []);

  const save = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const existing = sources.find(
        (source) => source.name.trim() === form.name.trim(),
      );
      if (existing) {
        setShowConnectionForm(false);
        await testAndBrowse(existing.id);
        return;
      }
      const value = await api<{ id: number; dataSources: DataSourceSummary[] }>(
        "/api/data-sources",
        { method: "POST", body: JSON.stringify(form) },
      );
      setSources(value.dataSources);
      setSelectedId(value.id);
      setForm((current) => ({ ...current, password: "" }));
      setShowConnectionForm(false);
      await testAndBrowse(value.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const testAndBrowse = async (id: number) => {
    setBusy(true);
    setError("");
    setMessage("");
    setObjectPreview(null);
    try {
      const connection = await api<any>(`/api/data-sources/${id}/test`, {
        method: "POST",
        body: "{}",
      });
      const value = await api<{ objects: any[] }>(
        `/api/data-sources/${id}/objects`,
      );
      setSelectedId(id);
      setObjects(value.objects);
      setSelectedObject("");
      setMessage(
        `连接成功：PostgreSQL ${connection.serverVersion}，只读会话已启用。`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const previewObject = async (value: string) => {
    setSelectedObject(value);
    setObjectPreview(null);
    if (!value || !selectedId) return;
    const [schemaName, objectName] = JSON.parse(value) as [string, string];
    setBusy(true);
    setError("");
    try {
      const preview = await api<any>(
        `/api/data-sources/${selectedId}/preview`,
        {
          method: "POST",
          body: JSON.stringify({ schemaName, objectName }),
        },
      );
      setObjectPreview(preview);
      const headers = preview.columns.map((column: any) => column.column_name);
      if (!headers.includes(updatedAtField) && headers.length)
        setUpdatedAtField(
          headers.includes("updated_at") ? "updated_at" : headers[0],
        );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveConfiguration = async () => {
    if (!selectedId || !selectedObject) return;
    const [schemaName, objectName] = JSON.parse(selectedObject) as [
      string,
      string,
    ];
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await api<any>(
        `/api/data-sources/${selectedId}/configuration`,
        {
          method: "POST",
          body: JSON.stringify({
            schemaName,
            objectName,
            updatedAtField,
            config: mapping,
          }),
        },
      );
      setSources(value.dataSources);
      const sync = await api<any>(`/api/data-sources/${selectedId}/full-sync`, {
        method: "POST",
        body: "{}",
      });
      if (sync.status !== "READY_TO_PUBLISH") {
        await loadSources();
        setMessage(
          `字段配置 V${value.versionNo} 已保存，但有 ${sync.errorRows ?? 0} 条数据需要处理。请查看同步批次详情。`,
        );
        return;
      }
      await api(`/api/sync-runs/${sync.syncRunId}/publish`, {
        method: "POST",
        body: "{}",
      });
      await loadSources();
      await onPublished();
      setObjects([]);
      setObjectPreview(null);
      setMessage(
        `接入完成：字段配置 V${value.versionNo} 已保存，${sync.validRows} 条数据已进入平台数仓并生成看板。`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const finishInitialSetup = async (id: number) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<any>(`/api/data-sources/${id}/full-sync`, {
        method: "POST",
        body: "{}",
      });
      if (result.status !== "READY_TO_PUBLISH") {
        await loadSources();
        setMessage(
          `已完成检查，但有 ${result.errorRows ?? 0} 条数据需要处理。请查看下方同步批次详情。`,
        );
        return;
      }
      await api(`/api/sync-runs/${result.syncRunId}/publish`, {
        method: "POST",
        body: "{}",
      });
      await loadSources();
      await onPublished();
      setMessage(
        `接入完成：${result.validRows} 条数据已进入平台数仓，看板已经生成。`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const publishRun = async (runId: number) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(`/api/sync-runs/${runId}/publish`, {
        method: "POST",
        body: "{}",
      });
      await loadSources();
      await onPublished();
      setMessage("首次全量数据已发布到平台数仓，看板已自动使用这批数据。");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const startIncrementalSync = async (id: number) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<any>(
        `/api/data-sources/${id}/incremental-sync`,
        { method: "POST", body: "{}" },
      );
      await loadSources();
      await onPublished();
      setMessage(
        `增量同步已自动发布：新增 ${result.newRows} 条，更新 ${result.updatedRows} 条，无变化 ${result.unchangedRows} 条。`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const updateSchedule = async (
    source: DataSourceSummary,
    enabled: boolean,
  ) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const current = source.schedule_json ?? {
        enabled: false,
        frequency: "DAILY" as const,
        hour: 2,
        minute: 0,
        dayOfWeek: 1,
        timezone: "Asia/Singapore",
      };
      const value = await api<{ dataSources: DataSourceSummary[] }>(
        `/api/data-sources/${source.id}/schedule`,
        {
          method: "POST",
          body: JSON.stringify({ ...current, enabled }),
        },
      );
      setSources(value.dataSources);
      setMessage(
        enabled
          ? "自动同步已启用，系统已计算下次运行时间。"
          : "已停用自动同步，手动增量同步仍可使用。",
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const changeScheduleTime = async (
    source: DataSourceSummary,
    value: string,
  ) => {
    const [hour, minute] = value.split(":").map(Number);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ dataSources: DataSourceSummary[] }>(
        `/api/data-sources/${source.id}/schedule`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(source.schedule_json ?? {
              enabled: false,
              frequency: "DAILY",
              dayOfWeek: 1,
              timezone: "Asia/Singapore",
            }),
            hour,
            minute,
          }),
        },
      );
      setSources(result.dataSources);
      setMessage(`自动同步时间已更新为 ${value}。`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const changeScheduleFrequency = async (
    source: DataSourceSummary,
    frequency: "EVERY_15_MINUTES" | "HOURLY" | "DAILY" | "WEEKLY",
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ dataSources: DataSourceSummary[] }>(
        `/api/data-sources/${source.id}/schedule`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(source.schedule_json ?? {
              enabled: false,
              hour: 2,
              minute: 0,
              dayOfWeek: 1,
              timezone: "Asia/Singapore",
            }),
            frequency,
          }),
        },
      );
      setSources(result.dataSources);
      setMessage("同步频率已更新，系统已重新计算下次运行时间。");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const changeScheduleDay = async (
    source: DataSourceSummary,
    dayOfWeek: number,
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ dataSources: DataSourceSummary[] }>(
        `/api/data-sources/${source.id}/schedule`,
        {
          method: "POST",
          body: JSON.stringify({ ...source.schedule_json, dayOfWeek }),
        },
      );
      setSources(result.dataSources);
      setMessage("每周同步日期已更新。");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const showSyncDetails = async (id: number) => {
    setBusy(true);
    setError("");
    try {
      setSyncDetails(await api(`/api/sync-runs/${id}`));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const retryRun = async (id: number) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<any>(`/api/sync-runs/${id}/retry`, {
        method: "POST",
        body: "{}",
      });
      await loadSources();
      await onPublished();
      setMessage(
        `已创建重试任务 #${result.syncRunId}，当前状态：${result.status}。`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const syncStatusLabel = (status: string) =>
    ({
      PUBLISHED: "已发布",
      READY_TO_PUBLISH: "待发布",
      FAILED: "技术失败",
      QUALITY_BLOCKED: "质量阻断",
      SCHEMA_BLOCKED: "结构阻断",
      CANCELLED: "已取消",
      CONNECTING: "连接中",
      EXTRACTING: "抽取中",
      VALIDATING: "校验中",
      PUBLISHING: "发布中",
      QUEUED: "排队中",
    })[status] ?? status;

  const columnOptions = objectPreview?.columns ?? [];
  const fieldSelect = (
    label: string,
    value: string,
    onChange: (value: string) => void,
  ) => (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">请选择字段</option>
        {columnOptions.map((column: any) => (
          <option key={column.column_name} value={column.column_name}>
            {column.column_name}（{column.data_type}）
          </option>
        ))}
      </select>
    </label>
  );

  const currentSource =
    sources.find((source) => source.id === selectedId) ?? sources[0];
  const setupStep = !currentSource
    ? 1
    : currentSource.status !== "ACTIVE"
      ? 2
      : currentSource.latest_sync_status !== "PUBLISHED"
        ? 3
        : 4;

  return (
    <section className="card">
      <SectionTitle
        title="正式接入：连接客户数据库"
        desc="只需配置一次。平台会将客户数据同步到平台数仓，之后看板自动更新"
      />
      <div className="setup-steps" aria-label="数据库接入进度">
        {[
          [1, "连接数据库", "保存后自动测试连接"],
          [2, "选择并匹配数据", "选择表或视图，确认字段"],
          [3, "生成看板", "一次导入并自动发布"],
        ].map(([step, title, desc]) => (
          <div
            key={step}
            className={`setup-step ${setupStep > Number(step) ? "done" : ""} ${setupStep === Number(step) ? "current" : ""}`}
          >
            <span>{setupStep > Number(step) ? "✓" : step}</span>
            <div>
              <b>{title}</b>
              <small>{desc}</small>
            </div>
          </div>
        ))}
      </div>
      {setupStep === 4 && (
        <div className="notice success">
          接入已完成。客户数据会按设定计划进入平台数仓并更新看板；下方操作属于日常维护，不需要再按接入步骤重做。
        </div>
      )}
      {!!sources.length && !showConnectionForm && (
        <div className="button-row">
          <button onClick={() => setShowConnectionForm(true)} disabled={busy}>
            添加另一个数据库连接
          </button>
        </div>
      )}
      {showConnectionForm && (
        <>
          <h3>第 1 步：填写客户数据库连接</h3>
          <p className="muted">
            保存后平台会立即测试只读连接；连接成功后自动进入数据选择。
          </p>
          <div className="mapping-grid">
            <label>
              数据源名称
              <input
                value={form.name}
                placeholder="例如：研发流程生产库"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              数据库地址
              <input
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
              />
            </label>
            <label>
              端口
              <input
                type="number"
                value={form.port}
                onChange={(e) =>
                  setForm({ ...form, port: Number(e.target.value) })
                }
              />
            </label>
            <label>
              数据库名称
              <input
                value={form.databaseName}
                onChange={(e) =>
                  setForm({ ...form, databaseName: e.target.value })
                }
              />
            </label>
            <label>
              只读用户名
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </label>
            <label>
              数据库密码
              <input
                type="password"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <label>
              TLS 安全模式
              <select
                value={form.sslMode}
                onChange={(e) => setForm({ ...form, sslMode: e.target.value })}
              >
                <option value="VERIFY_FULL">校验证书（正式环境）</option>
                <option value="REQUIRE">加密但不校验证书</option>
                <option value="DISABLE">不加密（仅限本机开发）</option>
              </select>
            </label>
          </div>
          <div className="button-row">
            <button className="primary" disabled={busy} onClick={save}>
              {busy ? "正在连接…" : "保存并测试连接"}
            </button>
            {!!sources.length && (
              <button
                disabled={busy}
                onClick={() => setShowConnectionForm(false)}
              >
                取消
              </button>
            )}
          </div>
        </>
      )}
      {!!sources.length && (
        <>
          <h3>{setupStep < 4 ? "当前接入进度" : "已连接的数据源"}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>数据源</th>
                  <th>连接位置</th>
                  <th>数据库</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>{source.name}</td>
                    <td>
                      {source.host}:{source.port}
                    </td>
                    <td>{source.database_name}</td>
                    <td>
                      <div>
                        {source.status === "ACTIVE" ? "已启用" : "配置中"}
                      </div>
                      {source.latest_sync_status && (
                        <small>
                          最近同步：
                          {source.latest_sync_status === "PUBLISHED"
                            ? "成功"
                            : source.latest_sync_status === "READY_TO_PUBLISH"
                              ? "待发布"
                              : source.latest_sync_status}
                        </small>
                      )}
                      {source.schedule_json?.enabled &&
                        source.schedule_json.nextRunAt && (
                          <small>
                            下次同步：
                            {new Date(
                              source.schedule_json.nextRunAt,
                            ).toLocaleString()}
                          </small>
                        )}
                    </td>
                    <td>
                      <div className="button-row compact-buttons">
                        <button
                          disabled={busy}
                          onClick={() => testAndBrowse(source.id)}
                        >
                          {source.status === "ACTIVE"
                            ? "检查连接与字段"
                            : "继续：选择业务数据"}
                        </button>
                        {source.status === "ACTIVE" &&
                          !source.latest_sync_status && (
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={() => finishInitialSetup(source.id)}
                            >
                              完成接入并生成看板
                            </button>
                          )}
                        {source.status === "ACTIVE" &&
                          source.latest_sync_status === "PUBLISHED" && (
                            <button
                              disabled={busy}
                              onClick={() => startIncrementalSync(source.id)}
                            >
                              立即增量同步
                            </button>
                          )}
                        {source.status === "ACTIVE" && (
                          <>
                            <select
                              aria-label={`${source.name} 同步频率`}
                              disabled={busy}
                              value={source.schedule_json?.frequency ?? "DAILY"}
                              onChange={(event) =>
                                changeScheduleFrequency(
                                  source,
                                  event.target.value as
                                    | "EVERY_15_MINUTES"
                                    | "HOURLY"
                                    | "DAILY"
                                    | "WEEKLY",
                                )
                              }
                            >
                              <option value="EVERY_15_MINUTES">
                                每 15 分钟
                              </option>
                              <option value="HOURLY">每小时</option>
                              <option value="DAILY">每天</option>
                              <option value="WEEKLY">每周</option>
                            </select>
                            {(source.schedule_json?.frequency ?? "DAILY") ===
                              "WEEKLY" && (
                              <select
                                aria-label={`${source.name} 每周同步日期`}
                                disabled={busy}
                                value={source.schedule_json?.dayOfWeek ?? 1}
                                onChange={(event) =>
                                  changeScheduleDay(
                                    source,
                                    Number(event.target.value),
                                  )
                                }
                              >
                                <option value={1}>星期一</option>
                                <option value={2}>星期二</option>
                                <option value={3}>星期三</option>
                                <option value={4}>星期四</option>
                                <option value={5}>星期五</option>
                                <option value={6}>星期六</option>
                                <option value={7}>星期日</option>
                              </select>
                            )}
                            {(source.schedule_json?.frequency ?? "DAILY") !==
                              "EVERY_15_MINUTES" && (
                              <input
                                aria-label={`${source.name} 自动同步时间`}
                                type="time"
                                disabled={busy}
                                value={`${String(source.schedule_json?.hour ?? 2).padStart(2, "0")}:${String(source.schedule_json?.minute ?? 0).padStart(2, "0")}`}
                                onChange={(event) =>
                                  changeScheduleTime(source, event.target.value)
                                }
                              />
                            )}
                            <button
                              disabled={busy}
                              onClick={() =>
                                updateSchedule(
                                  source,
                                  !(source.schedule_json?.enabled ?? false),
                                )
                              }
                            >
                              {source.schedule_json?.enabled
                                ? "停用自动同步"
                                : "启用自动同步"}
                            </button>
                          </>
                        )}
                        {source.latest_sync_status === "READY_TO_PUBLISH" &&
                          source.latest_sync_run_id && (
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={() =>
                                publishRun(Number(source.latest_sync_run_id))
                              }
                            >
                              确认发布 {source.latest_rows_read ?? 0} 条
                            </button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!!syncRuns.length && (
        <div className="stack compact-stack">
          <SectionTitle
            title="同步批次"
            desc="每次同步的读取、变化、质量和发布结果均保留，可点开查看异常证据"
          />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>批次</th>
                  <th>类型 / 触发</th>
                  <th>状态</th>
                  <th>读取</th>
                  <th>新增 / 更新 / 无变化</th>
                  <th>拒绝</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {syncRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <b>#{run.id}</b>
                      <small>{run.data_source_name}</small>
                    </td>
                    <td>
                      {run.run_type === "FULL" ? "全量" : "增量"} /{" "}
                      {run.trigger_type === "MANUAL"
                        ? "手动"
                        : run.trigger_type === "SCHEDULED"
                          ? "计划"
                          : `重试 ${run.attempt_no}`}
                    </td>
                    <td>
                      <span
                        className={`pill ${run.status === "PUBLISHED" ? "ok" : ["FAILED", "QUALITY_BLOCKED", "SCHEMA_BLOCKED"].includes(run.status) ? "bad" : ""}`}
                      >
                        {syncStatusLabel(run.status)}
                      </span>
                      {run.error_summary && <small>{run.error_summary}</small>}
                    </td>
                    <td>{run.rows_read}</td>
                    <td>
                      {run.rows_new} / {run.rows_updated} / {run.rows_unchanged}
                    </td>
                    <td>{run.rows_rejected}</td>
                    <td>
                      <div className="button-row compact-buttons">
                        <button
                          disabled={busy}
                          onClick={() => showSyncDetails(run.id)}
                        >
                          查看详情
                        </button>
                        {[
                          "FAILED",
                          "QUALITY_BLOCKED",
                          "SCHEMA_BLOCKED",
                          "CANCELLED",
                        ].includes(run.status) && (
                          <button
                            disabled={busy}
                            onClick={() => retryRun(run.id)}
                          >
                            重新运行
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {syncDetails && (
        <Modal
          title={`同步批次 #${syncDetails.run.id}`}
          onClose={() => setSyncDetails(null)}
        >
          <div className="preview-meta">
            <span>
              状态 <b>{syncStatusLabel(syncDetails.run.status)}</b>
            </span>
            <span>
              读取 <b>{syncDetails.run.rows_read}</b>
            </span>
            <span>
              拒绝 <b>{syncDetails.run.rows_rejected}</b>
            </span>
            <span>
              尝试次数 <b>{syncDetails.run.attempt_no}</b>
            </span>
          </div>
          {syncDetails.run.error_summary && (
            <div className="notice error">{syncDetails.run.error_summary}</div>
          )}
          {syncDetails.run.schema_change_json?.changed && (
            <div
              className={`notice ${
                syncDetails.run.schema_change_json.blocking
                  ? "error"
                  : "success"
              }`}
            >
              <b>源表结构变化：</b>
              {!!syncDetails.run.schema_change_json.added?.length && (
                <span>
                  新增字段 {syncDetails.run.schema_change_json.added.join("、")}
                  。
                </span>
              )}
              {!!syncDetails.run.schema_change_json.removedMapped?.length && (
                <span>
                  缺失的已映射字段{" "}
                  {syncDetails.run.schema_change_json.removedMapped.join("、")}
                  。
                </span>
              )}
              {!!syncDetails.run.schema_change_json.typeChangedMapped
                ?.length && (
                <span>
                  类型不兼容{" "}
                  {syncDetails.run.schema_change_json.typeChangedMapped
                    .map(
                      (item: any) =>
                        `${item.field}（${item.before} → ${item.after}）`,
                    )
                    .join("、")}
                  。
                </span>
              )}
              {!syncDetails.run.schema_change_json.blocking && (
                <span>现有映射不受影响，本批次可继续同步。</span>
              )}
            </div>
          )}
          {!!syncDetails.issues.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>来源行</th>
                    <th>业务主键</th>
                    <th>错误代码</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {syncDetails.issues.map((issue: any, index: number) => (
                    <tr key={`${issue.row_number}-${issue.code}-${index}`}>
                      <td>{issue.row_number}</td>
                      <td>{issue.ticket_id || "—"}</td>
                      <td>{issue.code}</td>
                      <td>{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="notice success">本批次没有数据质量错误。</div>
          )}
        </Modal>
      )}
      {!!objects.length && (
        <label className="field-block">
          <b>第 2 步：选择业务数据并确认字段</b>
          <small>完成确认后，平台会自动导入首批数据并生成看板。</small>
          选择要接入平台数仓的表或视图
          <select
            value={selectedObject}
            onChange={(e) => void previewObject(e.target.value)}
          >
            <option value="">请选择</option>
            {objects.map((item) => (
              <option
                key={`${item.schema_name}.${item.object_name}`}
                value={JSON.stringify([item.schema_name, item.object_name])}
              >
                {item.schema_name}.{item.object_name}（
                {item.object_kind === "VIEW" ? "视图" : "表"}）
              </option>
            ))}
          </select>
        </label>
      )}
      {objectPreview && (
        <div className="stack compact-stack">
          <div className="upload-ready">
            <div className="preview-meta">
              <span>
                字段 <b>{objectPreview.columns.length}</b>
              </span>
              <span>
                预览记录 <b>{objectPreview.rowCount}</b>
              </span>
            </div>
            <small>下面是唯一一次字段与流程映射。</small>
          </div>
          <div className="mapping-grid">
            {fieldSelect("业务主键", mapping.keyField, (value) =>
              setMapping({ ...mapping, keyField: value }),
            )}
            {fieldSelect("标题", mapping.titleField, (value) =>
              setMapping({ ...mapping, titleField: value }),
            )}
            {fieldSelect("团队", mapping.teamField, (value) =>
              setMapping({ ...mapping, teamField: value }),
            )}
            {fieldSelect("优先级", mapping.priorityField, (value) =>
              setMapping({ ...mapping, priorityField: value }),
            )}
            {fieldSelect("当前状态", mapping.statusField, (value) =>
              setMapping({ ...mapping, statusField: value }),
            )}
            {fieldSelect("发布结果", mapping.outcomeField, (value) =>
              setMapping({ ...mapping, outcomeField: value }),
            )}
            {fieldSelect("增量更新时间", updatedAtField, setUpdatedAtField)}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>流程环节</th>
                  <th>类型</th>
                  <th>开始字段</th>
                  <th>结束字段</th>
                </tr>
              </thead>
              <tbody>
                {mapping.stages.map((stage, index) => (
                  <tr key={stage.id}>
                    <td>{stage.name}</td>
                    <td>{stage.type === "waiting" ? "等待" : "处理"}</td>
                    <td>
                      <select
                        value={stage.startField}
                        onChange={(event) =>
                          setMapping({
                            ...mapping,
                            stages: mapping.stages.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, startField: event.target.value }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {columnOptions.map((column: any) => (
                          <option
                            key={column.column_name}
                            value={column.column_name}
                          >
                            {column.column_name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={stage.endField}
                        onChange={(event) =>
                          setMapping({
                            ...mapping,
                            stages: mapping.stages.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, endField: event.target.value }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {columnOptions.map((column: any) => (
                          <option
                            key={column.column_name}
                            value={column.column_name}
                          >
                            {column.column_name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy}
              onClick={saveConfiguration}
            >
              {busy ? "正在导入并生成看板…" : "确认字段并生成看板"}
            </button>
          </div>
        </div>
      )}
      {message && <div className="notice success">{message}</div>}
      {error && <div className="notice error">{error}</div>}
    </section>
  );
}

function Problems({ state, reload }: { state: State; reload: () => void }) {
  const [selected, setSelected] = useState<any>(state.problems[0] ?? null),
    [showCreate, setShowCreate] = useState(false),
    [statusFilter, setStatusFilter] = useState(""),
    [teamFilter, setTeamFilter] = useState(""),
    [ownerFilter, setOwnerFilter] = useState("");
  const visibleProblems = state.problems.filter(
    (problem: any) =>
      (!statusFilter || problem.status === statusFilter) &&
      (!teamFilter || problem.team === teamFilter) &&
      (!ownerFilter || problem.owner.includes(ownerFilter)),
  );
  useEffect(() => {
    if (selected)
      setSelected(
        state.problems.find((p) => p.id === selected.id) ?? state.problems[0],
      );
  }, [state.problems]);
  return (
    <div className="problem-layout">
      <section className="card problem-list">
        <div className="section-head">
          <div>
            <h2>改进项台账</h2>
            <p>{state.problems.length} 个改进项</p>
          </div>
          <button
            className="primary compact"
            onClick={() => setShowCreate(true)}
          >
            新建改进项
          </button>
        </div>
        <div className="filter-grid">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">全部状态</option>
            <option>新建</option>
            <option>进行中</option>
            <option>已完成</option>
          </select>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
          >
            <option value="">全部团队</option>
            {state.dashboard.teams.map((team: string) => (
              <option key={team}>{team}</option>
            ))}
          </select>
          <input
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            placeholder="筛选负责人"
          />
        </div>
        {visibleProblems.map((p) => (
          <button
            key={p.id}
            className={selected?.id === p.id ? "selected" : ""}
            onClick={() => setSelected(p)}
          >
            <span className="pill bad">{p.status}</span>
            {p.status === "进行中" &&
              p.due_date &&
              p.due_date < new Date().toISOString().slice(0, 10) && (
                <span className="pill bad">已逾期</span>
              )}
            <b>{p.title}</b>
            <small>
              {p.team} · 负责人：{p.owner}
            </small>
          </button>
        ))}
        {!visibleProblems.length && (
          <p className="muted">
            尚未创建改进项。从原因收集中识别出需要持续推进的改进方向后，在这里建立。
          </p>
        )}
      </section>
      <section className="card problem-detail">
        {selected ? (
          <ProblemDetail
            key={selected.id}
            problem={selected}
            teams={state.dashboard.teams}
            reload={reload}
          />
        ) : (
          <div className="empty-small">
            <b>选择一个改进项</b>
            <span>查看说明、负责人和当前进度</span>
          </div>
        )}
      </section>
      {showCreate && (
        <CreateProblem
          teams={state.dashboard.teams}
          onClose={() => setShowCreate(false)}
          onDone={async () => {
            setShowCreate(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ProblemDetail({ problem, teams, reload }: any) {
  const [transitionError, setTransitionError] = useState("");
  const [dueDate, setDueDate] = useState(problem.due_date ?? "");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    title: problem.title,
    impact: problem.impact,
    owner: problem.owner,
    team: problem.team,
    dueDate: problem.due_date ?? "",
  });
  const statuses = ["新建", "进行中", "已完成"];
  const nextStatus = statuses[statuses.indexOf(problem.status) + 1];
  const advance = async () => {
    try {
      setTransitionError("");
      await api(`/api/problems/${problem.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status: nextStatus, dueDate }),
      });
      await reload();
    } catch (error) {
      setTransitionError((error as Error).message);
    }
  };
  const save = async () => {
    try {
      setTransitionError("");
      await api(`/api/problems/${problem.id}`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      setEditing(false);
      await reload();
    } catch (error) {
      setTransitionError((error as Error).message);
    }
  };
  return (
    <>
      {editing ? (
        <div className="form-stack">
          <label>
            名称
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label>
            改进说明
            <textarea
              value={form.impact}
              onChange={(e) => setForm({ ...form, impact: e.target.value })}
            />
          </label>
          <label>
            所属团队
            <select
              value={form.team}
              onChange={(e) => setForm({ ...form, team: e.target.value })}
            >
              {teams.map((team: string) => (
                <option key={team}>{team}</option>
              ))}
            </select>
          </label>
          <label>
            负责人
            <input
              value={form.owner}
              onChange={(e) => setForm({ ...form, owner: e.target.value })}
            />
          </label>
          <label>
            计划完成日期
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            />
          </label>
          <div>
            <button className="primary compact" onClick={save}>
              保存修改
            </button>{" "}
            <button
              className="secondary compact"
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="section-head">
          <div>
            <span className="pill bad">{problem.status}</span>
            <h2>{problem.title}</h2>
            <p>{problem.impact}</p>
          </div>
          <div className="owner">
            所属团队<b>{problem.team}</b>
            负责人<b>{problem.owner}</b>
            {problem.due_date && <span>计划完成：{problem.due_date}</span>}
            {nextStatus === "进行中" && (
              <label>
                计划完成日期
                <input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </label>
            )}
            {nextStatus && (
              <button className="primary compact" onClick={advance}>
                进入{nextStatus}
              </button>
            )}
            <button
              className="secondary compact"
              onClick={() => setEditing(true)}
            >
              编辑改进项
            </button>
          </div>
        </div>
      )}
      {transitionError && <div className="alert error">{transitionError}</div>}
      <p className="muted">
        改进项可以来自原因收集中的分析和决策，但不与原始单据绑定。
      </p>
    </>
  );
}

function SubForm({ kind, problem, reload }: any) {
  const [form, setForm] = useState<any>({
    category: "资源与排期",
    detail: "",
    author: "流程执行人员",
    content: "",
    owner: "效能负责人",
    expectedChange: "",
    dueDate: "",
    baselineWindow: "2026-08-01 至 2026-08-31",
    afterWindow: "2026-09-01 至 2026-09-30",
    metric: "目标环节 P90",
    guardrail: "发布成功率",
    conclusion: "改善",
    notes: "",
  });
  const fields =
    kind === "reason"
      ? [
          ["category", "原因类别"],
          ["detail", "原因说明"],
          ["author", "填写人"],
        ]
      : kind === "action"
        ? [
            ["content", "行动内容"],
            ["owner", "负责人"],
            ["dueDate", "计划完成日"],
            ["expectedChange", "预期变化"],
          ]
        : [
            ["baselineWindow", "基线窗"],
            ["afterWindow", "后测窗"],
            ["metric", "主要指标"],
            ["guardrail", "效果护栏"],
            ["conclusion", "结论"],
            ["notes", "复核说明"],
          ];
  const list =
    kind === "reason"
      ? problem.reasons
      : kind === "action"
        ? problem.actions
        : problem.verifications;
  const save = async () => {
    await api(
      `/api/problems/${problem.id}/${kind === "reason" ? "reasons" : kind === "action" ? "actions" : "verifications"}`,
      { method: "POST", body: JSON.stringify(form) },
    );
    await reload();
  };
  const completeAction = async (actionId: number) => {
    await api(`/api/problems/${problem.id}/actions/${actionId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "已完成" }),
    });
    await reload();
  };
  const canAdd =
    (kind === "reason" && ["原因收集中", "分析中"].includes(problem.status)) ||
    (kind === "action" && problem.status === "分析中") ||
    (kind === "verification" && problem.status === "验证中");
  return (
    <div>
      {canAdd ? (
        <div className="mini-form">
          {fields.map(([key, label]) => (
            <label key={key}>
              {label}
              {key === "detail" || key === "content" || key === "notes" ? (
                <textarea
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              ) : key === "conclusion" ? (
                <select
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                >
                  <option>改善</option>
                  <option>未改善</option>
                  <option>恶化</option>
                  <option>证据不足</option>
                </select>
              ) : (
                <input
                  type={key === "dueDate" ? "date" : "text"}
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              )}
            </label>
          ))}
          <button className="primary compact" onClick={save}>
            添加记录
          </button>
        </div>
      ) : (
        <p className="muted">当前问题状态不能添加此类记录。</p>
      )}
      <div className="timeline">
        {list.map((x: any) => (
          <article key={x.id}>
            <b>{x.category || x.content || x.conclusion}</b>
            <p>{x.detail || x.expected_change || x.notes}</p>
            <small>{x.author || x.owner || x.created_at}</small>
            {kind === "action" &&
              x.status !== "已完成" &&
              problem.status === "行动中" && (
                <button
                  className="secondary compact"
                  onClick={() => completeAction(Number(x.id))}
                >
                  标记完成
                </button>
              )}
            {kind === "action" && (
              <span
                className={`status-pill ${x.status === "已完成" ? "ok" : ""}`}
              >
                {x.status}
              </span>
            )}
          </article>
        ))}
        {!list.length && <p className="muted">暂无记录</p>}
      </div>
    </div>
  );
}

function CreateProblem({ teams, onClose, onDone }: any) {
  const [f, setF] = useState({
    title: "",
    impact: "",
    owner: "效能负责人",
    team: teams[0] ?? "",
  });
  const save = async () => {
    await api("/api/problems", {
      method: "POST",
      body: JSON.stringify(f),
    });
    onDone();
  };
  return (
    <Modal title="新建改进项" onClose={onClose}>
      <div className="form-stack">
        <label>
          改进项名称
          <input
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
        </label>
        <label>
          改进说明
          <textarea
            value={f.impact}
            onChange={(e) => setF({ ...f, impact: e.target.value })}
          />
        </label>
        <label>
          所属团队
          <select
            value={f.team}
            onChange={(e) => setF({ ...f, team: e.target.value })}
          >
            {teams.map((team: string) => (
              <option key={team}>{team}</option>
            ))}
          </select>
        </label>
        <label>
          负责人
          <input
            value={f.owner}
            onChange={(e) => setF({ ...f, owner: e.target.value })}
          />
        </label>
        <button className="primary" onClick={save}>
          创建改进项
        </button>
      </div>
    </Modal>
  );
}

function StageChart({ stages }: { stages: StageSummary[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption({
      grid: { left: 38, right: 18, top: 14, bottom: 62 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: stages.map((s) => s.name),
        axisLabel: { rotate: 35, color: "#667085" },
      },
      yAxis: { type: "value", name: "小时" },
      series: [
        {
          type: "bar",
          data: stages.map((s) => ({
            value: s.p90Hours,
            itemStyle: {
              color: s.abnormal
                ? "#e2554f"
                : s.type === "waiting"
                  ? "#d6a84b"
                  : "#427c73",
              borderRadius: [5, 5, 0, 0],
            },
          })),
        },
      ],
    });
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [stages]);
  return <div ref={ref} className="chart" />;
}
function Kpi({ label, value, hint, tone = "" }: any) {
  return (
    <div className={`kpi card ${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
      <small>{hint}</small>
    </div>
  );
}
function SectionTitle({ title, desc }: any) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <p>{desc}</p>
    </div>
  );
}
function EmptyState({ onClick }: any) {
  return (
    <div className="empty card">
      <div className="empty-icon">↥</div>
      <h2>先接入第一份流程数据</h2>
      <p>
        上传项目提供的 UTF-8 CSV，映射字段并发布流程配置，即可生成运营看板。
      </p>
      <button className="primary" onClick={onClick}>
        开始配置
      </button>
    </div>
  );
}
function Modal({ title, onClose, children }: any) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.currentTarget === e.target) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          <button onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function TicketModal({ ticket, onClose }: any) {
  return (
    <Modal title={`${ticket.ticket_id} · ${ticket.title}`} onClose={onClose}>
      <div className="ticket-meta">
        <span>
          团队<b>{ticket.team}</b>
        </span>
        <span>
          优先级<b>{ticket.priority}</b>
        </span>
        <span>
          当前状态<b>{ticket.current_status}</b>
        </span>
        <span>
          发布结果<b>{ticket.release_result || "—"}</b>
        </span>
      </div>
      <div className="timeline stages">
        {ticket.observations.map((x: any) => (
          <article key={x.id} className={x.overdue ? "overdue" : ""}>
            <div>
              <b>{x.stage_name}</b>
              <span className={`pill ${x.stage_type}`}>
                {x.stage_type === "waiting" ? "等待" : "处理"}
              </span>
            </div>
            <p>
              {x.started_at
                ? new Date(x.started_at).toLocaleString()
                : "未开始"}{" "}
              →{" "}
              {x.ended_at
                ? new Date(x.ended_at).toLocaleString()
                : x.state === "active"
                  ? "进行中"
                  : "—"}
            </p>
            <small>
              {x.hours === null ? "无数据" : `${x.hours.toFixed(1)}h`} / SLA{" "}
              {x.sla_hours}h
            </small>
          </article>
        ))}
      </div>
    </Modal>
  );
}
