BEGIN;

ALTER TABLE import_batches
  ADD COLUMN IF NOT EXISTS structure_diff_json jsonb,
  ADD COLUMN IF NOT EXISTS structure_override_confirmed_at timestamptz;

ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_status_check;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_status_check CHECK (
  status IN ('READY_TO_PUBLISH', 'READY_WITH_ERRORS', 'AWAITING_STRUCTURE_DECISION',
             'PUBLISHED', 'REJECTED')
);

ALTER TABLE stage_observations
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS batch_id bigint REFERENCES import_batches(id),
  ADD COLUMN IF NOT EXISTS config_version_id bigint REFERENCES process_versions(id);

CREATE INDEX IF NOT EXISTS idx_stage_observations_current_ticket
  ON stage_observations(ticket_id, is_current);

INSERT INTO schema_migrations(version)
VALUES ('004_v02_process_structure_history')
ON CONFLICT (version) DO NOTHING;

COMMIT;
