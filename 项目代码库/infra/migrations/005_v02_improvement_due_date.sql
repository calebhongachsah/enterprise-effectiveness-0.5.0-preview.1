BEGIN;

ALTER TABLE problems ADD COLUMN IF NOT EXISTS due_date date;

INSERT INTO schema_migrations(version)
VALUES ('005_v02_improvement_due_date')
ON CONFLICT (version) DO NOTHING;

COMMIT;
