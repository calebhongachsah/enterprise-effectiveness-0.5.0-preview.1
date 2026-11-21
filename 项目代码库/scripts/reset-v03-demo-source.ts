import { Pool } from "pg";

const databaseUrl = process.env.SOURCE_DEMO_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("缺少 SOURCE_DEMO_DATABASE_URL");
if (new URL(databaseUrl).pathname !== "/effectiveness_source")
  throw new Error("演示数据脚本只允许运行于 effectiveness_source");

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query(`
    DROP VIEW IF EXISTS effectiveness_workflow_view;
    DROP TABLE IF EXISTS customer_workflow_events_demo;
    CREATE TABLE customer_workflow_events_demo AS
    WITH generated AS (
      SELECT g,
        CASE WHEN g <= 360 THEN (g - 1) % 9 ELSE 9 END AS active_stage,
        CASE WHEN g % 2 = 0 THEN now() - interval '2 hours'
             ELSE now() - interval '120 hours' END AS active_started_at
      FROM generate_series(1, 1002) AS g
    ), timed AS (
      SELECT *, active_started_at - active_stage * interval '4 hours' AS base_at
      FROM generated
    )
    SELECT
      'SRC-' || lpad(g::text, 6, '0') AS ticket_id,
      CASE WHEN active_stage < 9 THEN '在途演示事项 ' ELSE '已完成演示事项 ' END || g AS title,
      '团队' || ((g - 1) % 4 + 1) AS team,
      CASE WHEN g % 10 = 0 THEN 'P0' WHEN g % 3 = 0 THEN 'P2' ELSE 'P1' END AS priority,
      CASE active_stage
        WHEN 0 THEN '需求定义' WHEN 1 THEN '等待技术设计'
        WHEN 2 THEN '技术设计' WHEN 3 THEN '等待开发'
        WHEN 4 THEN '开发' WHEN 5 THEN '等待测试'
        WHEN 6 THEN '测试' WHEN 7 THEN '等待发布'
        WHEN 8 THEN '发布' ELSE '已发布' END AS current_status,
      CASE WHEN active_stage = 9 THEN CASE WHEN g % 20 = 0 THEN 'failed' ELSE 'success' END ELSE '' END AS release_result,
      CASE WHEN active_stage >= 0 THEN base_at END AS requirements_started_at,
      CASE WHEN active_stage > 0 OR active_stage = 9 THEN base_at + interval '3 hours' END AS requirements_ended_at,
      CASE WHEN active_stage >= 1 THEN base_at + interval '4 hours' END AS wait_design_started_at,
      CASE WHEN active_stage > 1 OR active_stage = 9 THEN base_at + interval '7 hours' END AS wait_design_ended_at,
      CASE WHEN active_stage >= 2 THEN base_at + interval '8 hours' END AS design_started_at,
      CASE WHEN active_stage > 2 OR active_stage = 9 THEN base_at + interval '11 hours' END AS design_ended_at,
      CASE WHEN active_stage >= 3 THEN base_at + interval '12 hours' END AS wait_development_started_at,
      CASE WHEN active_stage > 3 OR active_stage = 9 THEN base_at + interval '15 hours' END AS wait_development_ended_at,
      CASE WHEN active_stage >= 4 THEN base_at + interval '16 hours' END AS development_started_at,
      CASE WHEN active_stage > 4 OR active_stage = 9 THEN base_at + interval '19 hours' END AS development_ended_at,
      CASE WHEN active_stage >= 5 THEN base_at + interval '20 hours' END AS wait_testing_started_at,
      CASE WHEN active_stage > 5 OR active_stage = 9 THEN base_at + interval '23 hours' END AS wait_testing_ended_at,
      CASE WHEN active_stage >= 6 THEN base_at + interval '24 hours' END AS testing_started_at,
      CASE WHEN active_stage > 6 OR active_stage = 9 THEN base_at + interval '27 hours' END AS testing_ended_at,
      CASE WHEN active_stage >= 7 THEN base_at + interval '28 hours' END AS wait_release_started_at,
      CASE WHEN active_stage > 7 OR active_stage = 9 THEN base_at + interval '31 hours' END AS wait_release_ended_at,
      CASE WHEN active_stage >= 8 THEN base_at + interval '32 hours' END AS release_started_at,
      CASE WHEN active_stage = 9 THEN base_at + interval '35 hours' END AS release_ended_at,
      now() AS updated_at
    FROM timed;
    ALTER TABLE customer_workflow_events_demo ADD PRIMARY KEY(ticket_id);
    CREATE VIEW effectiveness_workflow_view AS
      SELECT * FROM customer_workflow_events_demo;
    GRANT SELECT ON effectiveness_workflow_view TO effectiveness_source_ro;
  `);
  const result = await pool.query(`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE release_ended_at IS NOT NULL)::int AS completed,
      count(*) FILTER (WHERE release_ended_at IS NULL)::int AS active
    FROM customer_workflow_events_demo
  `);
  console.log(JSON.stringify(result.rows[0]));
} finally {
  await pool.end();
}
