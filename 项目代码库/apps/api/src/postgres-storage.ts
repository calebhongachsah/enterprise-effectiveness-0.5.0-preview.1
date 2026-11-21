import type { PoolClient } from "pg";
import type {
  ProcessConfig,
  StageMeasurement,
} from "../../../packages/contracts/v01.js";
import type { Storage } from "./storage.js";
import { connectionPool } from "./postgres.js";

const pool = () => {
  const value = connectionPool();
  if (!value) throw new Error("PostgreSQL 尚未配置");
  return value;
};
const json = (value: unknown) => JSON.stringify(value);
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const jsonValue = <T>(value: T | string): T =>
  typeof value === "string" ? JSON.parse(value) : value;
const compat = (row: any, fields: string[]) => {
  const result = { ...row };
  for (const field of fields)
    if (result[field] !== null && typeof result[field] !== "string")
      result[field] = json(result[field]);
  return result;
};
async function tx<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function setSettingWith(client: PoolClient, key: string, value: unknown) {
  await client.query(
    `INSERT INTO settings(key, value_json) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    [key, json(value)],
  );
}

export const postgresStorage: Storage = {
  async listProcessSpaces() {
    return (
      await pool().query(
        `SELECT id, name, code, description, owner, status, is_default, created_at, updated_at
         FROM process_spaces ORDER BY is_default DESC, id`,
      )
    ).rows;
  },
  async createProcessSpace(input) {
    const result = await pool().query<{ id: string }>(
      `INSERT INTO process_spaces(name, code, description, owner)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.name, input.code, input.description, input.owner],
    );
    return { id: Number(result.rows[0].id) };
  },
  async updateProcessSpaceStatus(id, status) {
    const found = await pool().query<{ is_default: boolean }>(
      "SELECT is_default FROM process_spaces WHERE id = $1",
      [id],
    );
    if (!found.rows[0]) throw new Error("流程空间不存在");
    if (found.rows[0].is_default && status === "INACTIVE")
      throw new Error("默认流程空间不能停用");
    await pool().query(
      "UPDATE process_spaces SET status = $1, updated_at = now() WHERE id = $2",
      [status, id],
    );
  },
  async listImportBatches() {
    return (
      await pool()
        .query(`SELECT id, filename, imported_at, published_at, status,
        total_rows, valid_rows, error_rows, new_rows, updated_rows, unchanged_rows,
        config_version_id, structure_diff_json FROM import_batches ORDER BY id DESC`)
    ).rows;
  },
  async listProcessVersions() {
    return (
      await pool()
        .query(`SELECT id, version_no, status, change_note, created_at,
        published_at FROM process_versions ORDER BY version_no DESC`)
    ).rows;
  },
  async createProcessVersionDraft(config, baselines, changeNote) {
    return tx(async (client) => {
      await client.query("LOCK TABLE process_versions IN EXCLUSIVE MODE");
      const next = await client.query<{ value: number }>(
        "SELECT COALESCE(MAX(version_no), 0) + 1 AS value FROM process_versions",
      );
      const versionNo = Number(next.rows[0].value);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO process_versions(version_no, status, config_json,
          baselines_json, change_note, created_at)
         VALUES ($1, 'DRAFT', $2::jsonb, $3::jsonb, $4, $5) RETURNING id`,
        [versionNo, json(config), json(baselines), changeNote, new Date()],
      );
      return { id: Number(inserted.rows[0].id), versionNo };
    });
  },
  async publishProcessVersion(id) {
    return tx(async (client) => {
      const found = await client.query<any>(
        "SELECT * FROM process_versions WHERE id = $1 FOR UPDATE",
        [id],
      );
      const version = found.rows[0];
      if (!version) throw new Error("配置版本不存在");
      if (version.status !== "DRAFT") throw new Error("只有草稿配置可以发布");
      await client.query(
        "UPDATE process_versions SET status = 'RETIRED' WHERE status = 'PUBLISHED'",
      );
      await client.query(
        "UPDATE process_versions SET status = 'PUBLISHED', published_at = $1 WHERE id = $2",
        [new Date(), id],
      );
      await setSettingWith(client, "process_config", version.config_json);
      if (version.baselines_json)
        await setSettingWith(
          client,
          "operation_baselines",
          version.baselines_json,
        );
      return { id, versionNo: version.version_no, published: true };
    });
  },
  async getSetting<T>(key: string) {
    const result = await pool().query<{ value_json: T }>(
      "SELECT value_json FROM settings WHERE key = $1",
      [key],
    );
    return result.rows[0]?.value_json ?? null;
  },
  async setSetting(key, value) {
    const client = await pool().connect();
    try {
      await setSettingWith(client, key, value);
    } finally {
      client.release();
    }
  },
  async listOperationalReasons(teams = null) {
    return (
      await pool().query(
        `SELECT r.* FROM operational_reasons r JOIN work_items w USING (ticket_id)
         WHERE ($1::text[] IS NULL OR w.team=ANY($1)) ORDER BY r.updated_at DESC, r.ticket_id`,
        [teams],
      )
    ).rows;
  },
  async saveOperationalReason(input, teams) {
    const result = await pool().query(
      `INSERT INTO operational_reasons(ticket_id, stage_id, kind, category, detail, responsible_team, owner, due_date, status, updated_at)
       SELECT w.ticket_id, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM work_items w
       WHERE w.ticket_id=$1 AND ($11::text[] IS NULL OR w.team=ANY($11)) FOR SHARE
       ON CONFLICT(ticket_id, stage_id, kind) DO UPDATE SET
         category=excluded.category, detail=excluded.detail,
         responsible_team=excluded.responsible_team, owner=excluded.owner,
         due_date=excluded.due_date, status=excluded.status, updated_at=excluded.updated_at`,
      [
        input.ticketId,
        input.stageId,
        input.kind,
        input.category,
        input.detail,
        input.responsibleTeam,
        input.owner,
        input.dueDate,
        input.status,
        new Date(),
        teams,
      ],
    );
    return result.rowCount === 1;
  },
  async updateProcessConfig(config) {
    await tx(async (client) => {
      await setSettingWith(client, "process_config", config);
    });
  },
  async prepareImportBatch(
    filename,
    asOf,
    totalRows,
    rows,
    measurements,
    config,
    issues,
    structureDiff,
  ) {
    const existing = await pool().query<{
      ticket_id: string;
      source_json: any;
    }>("SELECT ticket_id, source_json FROM work_items");
    const current = new Map(
      existing.rows.map((row) => [row.ticket_id, stableJson(row.source_json)]),
    );
    const measurementsByTicket = new Map<string, StageMeasurement[]>();
    for (const item of measurements) {
      const grouped = measurementsByTicket.get(item.ticketId);
      if (grouped) grouped.push(item);
      else measurementsByTicket.set(item.ticketId, [item]);
    }
    const classified = rows.map((row) => {
      const ticketId = row[config.keyField];
      const sourceJson = json(row);
      const comparisonJson = stableJson(row);
      return {
        ticketId,
        sourceJson,
        classification: !current.has(ticketId)
          ? "new"
          : current.get(ticketId) === comparisonJson
            ? "unchanged"
            : "updated",
        measurements: measurementsByTicket.get(ticketId) ?? [],
      };
    });
    const counts = {
      newRows: classified.filter((row) => row.classification === "new").length,
      updatedRows: classified.filter((row) => row.classification === "updated")
        .length,
      unchangedRows: classified.filter(
        (row) => row.classification === "unchanged",
      ).length,
    };
    return tx(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO import_batches(filename, imported_at, as_of, total_rows,
          valid_rows, error_rows, status, config_json, new_rows, updated_rows, unchanged_rows,
          structure_diff_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb) RETURNING id`,
        [
          filename,
          new Date(),
          asOf,
          totalRows,
          rows.length,
          issues.length,
          structureDiff.changed
            ? "AWAITING_STRUCTURE_DECISION"
            : issues.length
              ? "READY_WITH_ERRORS"
              : "READY_TO_PUBLISH",
          json(config),
          counts.newRows,
          counts.updatedRows,
          counts.unchangedRows,
          json(structureDiff),
        ],
      );
      const batchId = Number(inserted.rows[0].id);
      for (let offset = 0; offset < classified.length; offset += 1000) {
        const chunk = classified.slice(offset, offset + 1000).map((row) => ({
          ticket_id: row.ticketId,
          classification: row.classification,
          source_json: JSON.parse(row.sourceJson),
          measurements_json: row.measurements,
        }));
        await client.query(
          `INSERT INTO import_batch_records
           (batch_id,ticket_id,classification,source_json,measurements_json)
           SELECT $1, value.ticket_id, value.classification,
             value.source_json, value.measurements_json
           FROM jsonb_to_recordset($2::jsonb) AS value(
             ticket_id text, classification text, source_json jsonb,
             measurements_json jsonb
           )`,
          [batchId, json(chunk)],
        );
      }
      for (const item of issues)
        await client.query(
          `INSERT INTO import_issues(batch_id,row_number,ticket_id,code,message)
           VALUES ($1,$2,$3,$4,$5)`,
          [batchId, item.row, item.ticketId ?? null, item.code, item.message],
        );
      return { batchId, ...counts, errorRows: issues.length, structureDiff };
    });
  },
  async publishImportBatch(
    batchId,
    allowStructureOverride = false,
    dataSourceId,
  ) {
    return tx(async (client) => {
      const found = await client.query<any>(
        "SELECT * FROM import_batches WHERE id=$1 FOR UPDATE",
        [batchId],
      );
      const batch = found.rows[0];
      if (!batch) throw new Error("导入批次不存在");
      if (
        batch.status === "AWAITING_STRUCTURE_DECISION" &&
        !allowStructureOverride
      )
        throw new Error("流程结构发生变化，请先选择放弃导入或确认覆盖流程");
      if (
        ![
          "READY_TO_PUBLISH",
          "READY_WITH_ERRORS",
          "AWAITING_STRUCTURE_DECISION",
        ].includes(batch.status)
      )
        throw new Error("当前批次不能发布");
      const config = jsonValue<ProcessConfig>(batch.config_json);
      const current = (
        await client.query<any>(
          "SELECT * FROM process_versions WHERE status='PUBLISHED' ORDER BY version_no DESC LIMIT 1 FOR UPDATE",
        )
      ).rows[0];
      let configVersionId = current ? Number(current.id) : undefined;
      if (
        !current ||
        stableJson(current.config_json) !== stableJson(batch.config_json)
      ) {
        if (current)
          await client.query(
            "UPDATE process_versions SET status='RETIRED' WHERE status='PUBLISHED'",
          );
        const nextVersion = Number(current?.version_no ?? 0) + 1;
        const created = await client.query<{ id: string }>(
          `INSERT INTO process_versions(version_no,status,config_json,change_note,created_at,published_at)
           VALUES ($1,'PUBLISHED',$2::jsonb,$3,$4,$4) RETURNING id`,
          [
            nextVersion,
            json(config),
            current ? `随导入批次 #${batchId} 发布` : "首次配置发布",
            new Date(),
          ],
        );
        configVersionId = Number(created.rows[0].id);
      }
      if (!configVersionId) throw new Error("无法确定配置版本");
      await client.query(
        `INSERT INTO work_items(ticket_id,title,team,priority,current_status,
          release_result,source_json,batch_id)
         SELECT record.ticket_id,
          COALESCE(record.source_json ->> $2, ''),
          COALESCE(record.source_json ->> $3, ''),
          COALESCE(record.source_json ->> $4, ''),
          COALESCE(record.source_json ->> $5, ''),
          COALESCE(record.source_json ->> $6, ''),
          record.source_json,$1
         FROM import_batch_records record
         WHERE record.batch_id=$1 AND record.classification<>'unchanged'
         ON CONFLICT(ticket_id) DO UPDATE SET title=excluded.title,
          team=excluded.team,priority=excluded.priority,
          current_status=excluded.current_status,
          release_result=excluded.release_result,source_json=excluded.source_json,
          batch_id=excluded.batch_id`,
        [
          batchId,
          config.titleField,
          config.teamField,
          config.priorityField,
          config.statusField,
          config.outcomeField,
        ],
      );
      await client.query(
        `UPDATE stage_observations observation SET is_current=false
         FROM import_batch_records record
         WHERE record.batch_id=$1 AND record.classification<>'unchanged'
           AND observation.ticket_id=record.ticket_id
           AND observation.is_current=true`,
        [batchId],
      );
      await client.query(
        `INSERT INTO stage_observations(ticket_id,stage_id,stage_name,stage_type,
          priority,started_at,ended_at,state,hours,sla_hours,overdue,is_current,
          batch_id,config_version_id)
         SELECT record.ticket_id,item->>'stageId',item->>'stageName',
          item->>'stageType',item->>'priority',
          NULLIF(item->>'startedAt','')::timestamptz,
          NULLIF(item->>'endedAt','')::timestamptz,item->>'state',
          NULLIF(item->>'hours','')::double precision,
          NULLIF(item->>'slaHours','')::double precision,
          NULLIF(item->>'overdue','')::boolean,true,$1,$2
         FROM import_batch_records record
         CROSS JOIN LATERAL jsonb_array_elements(record.measurements_json) item
         WHERE record.batch_id=$1 AND record.classification<>'unchanged'`,
        [batchId, configVersionId],
      );
      if (dataSourceId) {
        await client.query(
          `UPDATE work_items wi SET data_source_id = $1
           FROM import_batch_records ibr
           WHERE ibr.batch_id = $2 AND wi.ticket_id = ibr.ticket_id`,
          [dataSourceId, batchId],
        );
        await setSettingWith(client, "active_data_source_id", dataSourceId);
      }
      await setSettingWith(client, "process_config", config);
      await client.query(
        `UPDATE import_batches SET status='PUBLISHED',published_at=$1,
          config_version_id=$2,structure_override_confirmed_at=$4 WHERE id=$3`,
        [
          new Date(),
          configVersionId,
          batchId,
          allowStructureOverride ? new Date() : null,
        ],
      );
      return { batchId, published: true };
    });
  },
  async rejectImportBatch(batchId) {
    const result = await pool().query(
      `UPDATE import_batches SET status='REJECTED'
       WHERE id=$1 AND status='AWAITING_STRUCTURE_DECISION'`,
      [batchId],
    );
    if (!result.rowCount) throw new Error("当前批次不能放弃");
  },
  async listProblems(teams = null) {
    const problems = (
      await pool().query(
        "SELECT * FROM problems WHERE ($1::text[] IS NULL OR team=ANY($1)) ORDER BY id DESC",
        [teams],
      )
    ).rows;
    return Promise.all(
      problems.map(async (problem) => {
        const id = Number(problem.id);
        const [tickets, reasons, actions, verifications] = await Promise.all([
          pool().query(
            "SELECT ticket_id FROM problem_work_items WHERE problem_id=$1",
            [id],
          ),
          pool().query(
            "SELECT * FROM reasons WHERE problem_id=$1 ORDER BY id DESC",
            [id],
          ),
          pool().query(
            "SELECT * FROM actions WHERE problem_id=$1 ORDER BY id DESC",
            [id],
          ),
          pool().query(
            "SELECT * FROM verifications WHERE problem_id=$1 ORDER BY id DESC",
            [id],
          ),
        ]);
        return {
          ...problem,
          ticketIds: tickets.rows.map((r: any) => r.ticket_id),
          reasons: reasons.rows,
          actions: actions.rows,
          verifications: verifications.rows,
        };
      }),
    );
  },
  async listWorkItemsRaw() {
    return (
      await pool().query(
        `SELECT * FROM work_items
         WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='active_data_source_id')
            OR data_source_id = (
              SELECT (value_json #>> '{}')::bigint FROM settings WHERE key='active_data_source_id'
            )
         ORDER BY ticket_id`,
      )
    ).rows.map((row) => compat(row, ["source_json"]));
  },
  async listStageObservationsForTickets(ticketIds) {
    if (!ticketIds.length) return [];
    return (
      await pool().query(
        "SELECT * FROM stage_observations WHERE ticket_id=ANY($1::text[]) AND is_current=true ORDER BY ticket_id,id",
        [ticketIds],
      )
    ).rows;
  },
  async getLatestPublishedBatch() {
    return (
      await pool().query(
        "SELECT * FROM import_batches WHERE status='PUBLISHED' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0];
  },
  async listWorkItemTeams() {
    return (
      await pool().query(
        `SELECT DISTINCT team FROM work_items
         WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='active_data_source_id')
            OR data_source_id = (
              SELECT (value_json #>> '{}')::bigint FROM settings WHERE key='active_data_source_id'
            )
         ORDER BY team`,
      )
    ).rows.map((row) => row.team);
  },
  async getSampleSource() {
    const row = (
      await pool().query(
        `SELECT source_json FROM work_items
         WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='active_data_source_id')
            OR data_source_id = (
              SELECT (value_json #>> '{}')::bigint FROM settings WHERE key='active_data_source_id'
            )
         LIMIT 1`,
      )
    ).rows[0];
    return row ? compat(row, ["source_json"]) : undefined;
  },
  async listStageObservationsForStage(stageId) {
    return (
      await pool().query(
        "SELECT * FROM stage_observations WHERE stage_id=$1 AND is_current=true ORDER BY overdue DESC,hours DESC",
        [stageId],
      )
    ).rows;
  },
  async getWorkItemWithObservations(ticketId) {
    const item = (
      await pool().query("SELECT * FROM work_items WHERE ticket_id=$1", [
        ticketId,
      ])
    ).rows[0];
    if (!item) return null;
    const observations = (
      await pool().query(
        "SELECT * FROM stage_observations WHERE ticket_id=$1 AND is_current=true ORDER BY id",
        [ticketId],
      )
    ).rows;
    return {
      ...compat(item, ["source_json"]),
      source: item.source_json,
      observations,
    };
  },
  async createProblem(input) {
    return tx(async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO problems(title,stage_id,impact,owner,team,status,created_at)
         VALUES ($1,$2,$3,$4,$5,'新建',$6) RETURNING id`,
        [
          input.title,
          input.stageId,
          input.impact,
          input.owner,
          input.team,
          new Date(),
        ],
      );
      const id = Number(created.rows[0].id);
      for (const ticketId of input.ticketIds)
        await client.query(
          "INSERT INTO problem_work_items(problem_id,ticket_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [id, ticketId],
        );
      return id;
    });
  },
  async addProblemReason(problemId, input) {
    await pool().query(
      `INSERT INTO reasons(problem_id,ticket_id,category,detail,author,created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        problemId,
        input.ticketId || null,
        input.category,
        input.detail,
        input.author,
        new Date(),
      ],
    );
  },
  async addProblemAction(problemId, input) {
    await pool().query(
      `INSERT INTO actions(problem_id,content,owner,due_date,status,expected_change)
       VALUES ($1,$2,$3,$4,'计划中',$5)`,
      [
        problemId,
        input.content,
        input.owner,
        input.dueDate || null,
        input.expectedChange,
      ],
    );
  },
  async addProblemVerification(problemId, input) {
    await pool().query(
      `INSERT INTO verifications(problem_id,baseline_window,after_window,metric,
        guardrail,conclusion,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        problemId,
        input.baselineWindow,
        input.afterWindow,
        input.metric,
        input.guardrail,
        input.conclusion,
        input.notes,
        new Date(),
      ],
    );
  },
  async updateProblemStatus(problemId, status, dueDate, teams) {
    const result = await pool().query(
      `UPDATE problems SET status=$1, due_date=COALESCE($2::date, due_date)
       WHERE id=$3 AND ($4::text[] IS NULL OR team=ANY($4))`,
      [status, dueDate ?? null, problemId, teams],
    );
    return result.rowCount === 1;
  },
  async updateProblem(problemId, input, teams) {
    const result = await pool().query(
      `UPDATE problems SET title=$1, impact=$2, owner=$3, team=$4, due_date=$5
       WHERE id=$6 AND ($7::text[] IS NULL OR team=ANY($7))`,
      [
        input.title,
        input.impact,
        input.owner,
        input.team,
        input.dueDate || null,
        problemId,
        teams,
      ],
    );
    return result.rowCount === 1;
  },
  async updateProblemActionStatus(problemId, actionId, status, teams) {
    const result = await pool().query(
      `UPDATE actions SET status=$1 WHERE id=$2 AND problem_id=$3 AND EXISTS (
         SELECT 1 FROM problems WHERE id=$3 AND ($4::text[] IS NULL OR team=ANY($4)) FOR SHARE
       )`,
      [status, actionId, problemId, teams],
    );
    return result.rowCount === 1;
  },
};
