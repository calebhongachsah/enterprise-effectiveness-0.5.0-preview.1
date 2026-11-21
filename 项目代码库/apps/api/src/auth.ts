import crypto from "node:crypto";
import { promisify } from "node:util";
import type http from "node:http";
import { connectionPool } from "./postgres.js";

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = "effectiveness_session";
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const secureCookies = process.env.SESSION_COOKIE_SECURE === "true";
const bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim() ?? "";
const bootstrapTokenPattern = /^[0-9a-f]{64}$/;

export const bootstrapConfigured = bootstrapTokenPattern.test(bootstrapToken);

export function validBootstrapToken(input: unknown) {
  return (
    bootstrapConfigured &&
    typeof input === "string" &&
    bootstrapTokenPattern.test(input) &&
    crypto.timingSafeEqual(
      Buffer.from(input, "hex"),
      Buffer.from(bootstrapToken, "hex"),
    )
  );
}

export type Role =
  "SYSTEM_ADMIN" | "OPERATIONS_LEAD" | "TEAM_LEAD" | "EXECUTOR" | "VIEWER";

export type Actor = {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  teams: string[];
  sessionId: string;
  mustChangePassword: boolean;
};

export const authRequired = Boolean(process.env.DATABASE_URL?.trim());

function pool() {
  const value = connectionPool();
  if (!value) throw new Error("认证仅可在 PostgreSQL 模式使用");
  return value;
}

function cookies(req: http.IncomingMessage) {
  return Object.fromEntries(
    String(req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split(/=(.*)/s).slice(0, 2))
      .filter(([key]) => key),
  );
}

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function passwordHash(password: string) {
  const salt = crypto.randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt64, expected64] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt64 || !expected64) return false;
  const expected = Buffer.from(expected64, "base64");
  const actual = (await scrypt(
    password,
    Buffer.from(salt64, "base64"),
    expected.length,
  )) as Buffer;
  return crypto.timingSafeEqual(actual, expected);
}

export function passwordError(password: string) {
  if (password.length < 12) return "密码至少需要 12 个字符";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
    return "密码必须同时包含字母和数字";
  return null;
}

export async function needsBootstrap() {
  const result = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM users",
  );
  return Number(result.rows[0].count) === 0;
}

export async function bootstrapAdmin(
  input: { username: string; displayName: string; password: string },
  req: http.IncomingMessage,
) {
  const username = input.username.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(20261006)");
    const count = await client.query(
      "SELECT count(*)::int AS count FROM users",
    );
    if (count.rows[0].count !== 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const created = await client.query<{ id: number }>(
      `INSERT INTO users(username, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'SYSTEM_ADMIN') RETURNING id`,
      [username, displayName, await passwordHash(input.password)],
    );
    await client.query(
      `INSERT INTO audit_events(user_id, source_ip, action, object_type, object_id, result)
       VALUES ($1::bigint, $2, 'AUTH_BOOTSTRAP_ADMIN', 'user', ($1::bigint)::text, 'SUCCESS')`,
      [created.rows[0].id, req.socket.remoteAddress ?? null],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function login(
  usernameInput: string,
  password: string,
  req: http.IncomingMessage,
) {
  const username = usernameInput.trim().toLowerCase();
  const result = await pool().query<any>(
    "SELECT * FROM users WHERE username = $1",
    [username],
  );
  const user = result.rows[0];
  const now = Date.now();
  if (
    !user ||
    !user.active ||
    (user.locked_until && Date.parse(user.locked_until) > now) ||
    !(await verifyPassword(password, user.password_hash))
  ) {
    if (
      user?.active &&
      (!user.locked_until || Date.parse(user.locked_until) <= now)
    ) {
      await pool().query(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 * interval '1 millisecond') ELSE NULL END,
         updated_at = now() WHERE id = $1`,
        [user.id, MAX_FAILURES, LOCK_MS],
      );
    }
    await audit(null, req, "AUTH_LOGIN", "session", null, "DENIED", {
      username,
    });
    return null;
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const sessionId = crypto.randomUUID();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1",
      [user.id],
    );
    await client.query(
      `INSERT INTO sessions(id, user_id, token_hash, created_at, last_seen_at, expires_at, source_ip, user_agent)
       VALUES ($1, $2, $3, now(), now(), now() + ($4 * interval '1 millisecond'), $5, $6)`,
      [
        sessionId,
        user.id,
        tokenHash(token),
        ABSOLUTE_MS,
        req.socket.remoteAddress ?? null,
        req.headers["user-agent"] ?? null,
      ],
    );
    await client.query(
      `INSERT INTO audit_events(user_id, session_id, source_ip, action, object_type, object_id, result)
       VALUES ($1, $2::uuid, $3, 'AUTH_LOGIN', 'session', ($2::uuid)::text, 'SUCCESS')`,
      [user.id, sessionId, req.socket.remoteAddress ?? null],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { token, actor: await actorForSession(token) };
}

export async function actorForSession(token: string): Promise<Actor | null> {
  if (!token) return null;
  const result = await pool().query<any>(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.username, u.display_name, u.role, u.must_change_password,
       coalesce(array_agg(uts.team) FILTER (WHERE uts.team IS NOT NULL), '{}') AS teams
     FROM sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN user_team_scopes uts ON uts.user_id = u.id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active = true
     GROUP BY s.id, u.id`,
    [tokenHash(token)],
  );
  const row = result.rows[0];
  if (!row || Date.now() - Date.parse(row.last_seen_at) > IDLE_MS) return null;
  await pool().query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [
    row.session_id,
  ]);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    teams: row.teams,
    sessionId: row.session_id,
    mustChangePassword: row.must_change_password,
  };
}

export async function actorFromRequest(req: http.IncomingMessage) {
  const token = cookies(req)[COOKIE_NAME] ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? actorForSession(token) : null;
}

export function sessionCookie(token: string) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ABSOLUTE_MS / 1000}${secureCookies ? "; Secure" : ""}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? "; Secure" : ""}`;
}

export async function logout(actor: Actor, req: http.IncomingMessage) {
  await pool().query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [
    actor.sessionId,
  ]);
  await audit(actor, req, "AUTH_LOGOUT", "session", actor.sessionId, "SUCCESS");
}

export const capabilities: Record<Role, Set<string>> = {
  SYSTEM_ADMIN: new Set([
    "read",
    "import",
    "publish_data",
    "configure",
    "publish_config",
    "reason",
    "operate",
    "manage_users",
    "manage_data_sources",
    "audit",
  ]),
  OPERATIONS_LEAD: new Set([
    "read",
    "import",
    "publish_data",
    "configure",
    "publish_config",
    "reason",
    "operate",
  ]),
  TEAM_LEAD: new Set(["read", "reason", "operate"]),
  EXECUTOR: new Set(["read", "reason"]),
  VIEWER: new Set(["read"]),
};

export function can(actor: Actor, capability: string) {
  return capabilities[actor.role].has(capability);
}

export function scopedTeams(actor: Actor) {
  return actor.role === "SYSTEM_ADMIN" || actor.role === "OPERATIONS_LEAD"
    ? null
    : actor.teams;
}

export async function audit(
  actor: Actor | null,
  req: http.IncomingMessage,
  action: string,
  objectType: string,
  objectId: string | null,
  result: "SUCCESS" | "DENIED" | "FAILED",
  details: Record<string, unknown> = {},
) {
  await pool().query(
    `INSERT INTO audit_events(user_id, session_id, source_ip, action, object_type, object_id, result, details_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actor?.id ?? null,
      actor?.sessionId ?? null,
      req.socket.remoteAddress ?? null,
      action,
      objectType,
      objectId,
      result,
      JSON.stringify(details),
    ],
  );
}

export async function listAuditEvents() {
  const result = await pool().query(
    `SELECT ae.id, ae.occurred_at, u.username, ae.action, ae.object_type, ae.object_id, ae.result, ae.details_json
     FROM audit_events ae LEFT JOIN users u ON u.id = ae.user_id ORDER BY ae.id DESC LIMIT 200`,
  );
  return result.rows;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: Role;
  teams?: string[];
}) {
  const error = passwordError(input.password);
  if (error) throw new Error(error);
  if (!capabilities[input.role]) throw new Error("无效角色");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const created = await client.query<{ id: number }>(
      `INSERT INTO users(username, display_name, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [
        input.username.trim().toLowerCase(),
        input.displayName.trim(),
        await passwordHash(input.password),
        input.role,
      ],
    );
    for (const team of [...new Set(input.teams ?? [])])
      await client.query(
        "INSERT INTO user_team_scopes(user_id, team) VALUES ($1, $2)",
        [created.rows[0].id, team],
      );
    await client.query("COMMIT");
    return created.rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listUsers() {
  const result = await pool().query(
    `SELECT u.id, u.username, u.display_name, u.role, u.active, u.must_change_password,
       u.locked_until, u.created_at,
       coalesce(array_agg(uts.team ORDER BY uts.team) FILTER (WHERE uts.team IS NOT NULL), '{}') AS teams
     FROM users u LEFT JOIN user_team_scopes uts ON uts.user_id = u.id
     GROUP BY u.id ORDER BY u.id`,
  );
  return result.rows;
}

export async function setUserActive(userId: number, active: boolean) {
  const result = await pool().query(
    "UPDATE users SET active=$2, updated_at=now() WHERE id=$1 RETURNING id",
    [userId, active],
  );
  if (!result.rowCount) throw new Error("账号不存在");
  if (!active)
    await pool().query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [userId],
    );
}

export async function resetUserPassword(userId: number, password: string) {
  const error = passwordError(password);
  if (error) throw new Error(error);
  const result = await pool().query(
    `UPDATE users SET password_hash=$2, must_change_password=true,
     failed_login_count=0, locked_until=NULL, password_changed_at=now(), updated_at=now()
     WHERE id=$1 RETURNING id`,
    [userId, await passwordHash(password)],
  );
  if (!result.rowCount) throw new Error("账号不存在");
  await pool().query(
    "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
    [userId],
  );
}

export async function changeOwnPassword(
  actor: Actor,
  currentPassword: string,
  newPassword: string,
) {
  const error = passwordError(newPassword);
  if (error) throw new Error(error);
  const result = await pool().query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id=$1 AND active=true",
    [actor.id],
  );
  if (
    !result.rows[0] ||
    !(await verifyPassword(currentPassword, result.rows[0].password_hash))
  )
    throw new Error("当前密码不正确");
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users SET password_hash=$2, must_change_password=false,
       password_changed_at=now(), updated_at=now() WHERE id=$1`,
      [actor.id, await passwordHash(newPassword)],
    );
    await client.query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL",
      [actor.id, actor.sessionId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
