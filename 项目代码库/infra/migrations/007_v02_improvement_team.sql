BEGIN;

ALTER TABLE problems ADD COLUMN IF NOT EXISTS team text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_problems_team_status ON problems(team, status);

INSERT INTO schema_migrations(version)
VALUES ('007_v02_improvement_team')
ON CONFLICT (version) DO NOTHING;

COMMIT;
