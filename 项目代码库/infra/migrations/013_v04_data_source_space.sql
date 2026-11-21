BEGIN;

ALTER TABLE data_sources
  ADD COLUMN process_space_id bigint REFERENCES process_spaces(id);

UPDATE data_sources AS source
SET process_space_id = space.id
FROM process_spaces AS space
WHERE space.code = source.process_id;

ALTER TABLE data_sources
  ALTER COLUMN process_space_id SET NOT NULL,
  DROP COLUMN process_id,
  ADD CONSTRAINT data_sources_space_name_key UNIQUE (process_space_id, name);

INSERT INTO schema_migrations(version)
VALUES ('013_v04_data_source_space')
ON CONFLICT(version) DO NOTHING;

COMMIT;
