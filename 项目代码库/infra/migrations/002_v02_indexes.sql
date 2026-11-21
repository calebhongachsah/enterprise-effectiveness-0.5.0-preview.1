BEGIN;

CREATE INDEX IF NOT EXISTS idx_import_batches_status_imported
  ON import_batches(status, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_config_version
  ON import_batches(config_version_id);
CREATE INDEX IF NOT EXISTS idx_import_issues_batch
  ON import_issues(batch_id);
CREATE INDEX IF NOT EXISTS idx_work_items_team_priority
  ON work_items(team, priority);
CREATE INDEX IF NOT EXISTS idx_work_items_batch
  ON work_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_stage_observations_stage
  ON stage_observations(stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_observations_ticket_stage
  ON stage_observations(ticket_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_observations_stage_overdue
  ON stage_observations(stage_id, overdue);
CREATE INDEX IF NOT EXISTS idx_problems_stage_status
  ON problems(stage_id, status);

INSERT INTO schema_migrations(version)
VALUES ('002_v02_indexes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
