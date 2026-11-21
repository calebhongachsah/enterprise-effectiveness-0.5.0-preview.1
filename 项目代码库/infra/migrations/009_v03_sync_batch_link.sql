BEGIN;

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS import_batch_id bigint REFERENCES import_batches(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_import_batch
  ON sync_runs(import_batch_id)
  WHERE import_batch_id IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('009_v03_sync_batch_link')
ON CONFLICT (version) DO NOTHING;

COMMIT;
