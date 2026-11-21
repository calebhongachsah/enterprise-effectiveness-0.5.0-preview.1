BEGIN;

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS schema_change_json jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO schema_migrations(version)
VALUES ('011_v03_schema_drift')
ON CONFLICT (version) DO NOTHING;

COMMIT;
