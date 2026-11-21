BEGIN;

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS data_source_id bigint REFERENCES data_sources(id);

CREATE INDEX IF NOT EXISTS idx_work_items_data_source
  ON work_items(data_source_id, ticket_id);

INSERT INTO schema_migrations(version)
VALUES ('010_v03_work_item_source')
ON CONFLICT (version) DO NOTHING;

COMMIT;
