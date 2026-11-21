BEGIN;

ALTER TABLE operational_reasons
  ADD COLUMN IF NOT EXISTS responsible_team text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS due_date date,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT '已填写';

ALTER TABLE operational_reasons DROP CONSTRAINT IF EXISTS operational_reasons_status_check;
ALTER TABLE operational_reasons ADD CONSTRAINT operational_reasons_status_check
  CHECK (status IN ('待填写', '已填写'));

INSERT INTO schema_migrations(version)
VALUES ('006_v02_reason_responsibility')
ON CONFLICT (version) DO NOTHING;

COMMIT;
