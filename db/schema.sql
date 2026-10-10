-- Leaf Peep schema. Runs on Tiger Data (Tiger Cloud) or any TimescaleDB.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- One row per photo someone scored on a walk.
-- Location is stored coarsened to a ~1 km grid cell; the exact GPS never hits the database.
CREATE TABLE IF NOT EXISTS sightings (
  time          TIMESTAMPTZ NOT NULL DEFAULT now(),
  cell_lat      DOUBLE PRECISION NOT NULL,
  cell_lng      DOUBLE PRECISION NOT NULL,
  stage         TEXT NOT NULL,          -- green | turning | near_peak | peak | past
  color_score   SMALLINT NOT NULL,      -- 0 (all green) .. 100 (full peak)
  colors        TEXT[] NOT NULL DEFAULT '{}',
  trees         TEXT,
  note          TEXT,
  photo_key     TEXT,
  model         TEXT NOT NULL
);

SELECT create_hypertable('sightings', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS sightings_cell_time ON sightings (cell_lat, cell_lng, time DESC);

-- Daily colour per cell, kept fresh by Timescale so the map query stays cheap.
CREATE MATERIALIZED VIEW IF NOT EXISTS cell_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 day', time) AS day,
       cell_lat, cell_lng,
       avg(color_score)::real AS score,
       count(*)              AS photos
FROM sightings
GROUP BY day, cell_lat, cell_lng
WITH NO DATA;

SELECT add_continuous_aggregate_policy('cell_daily',
  start_offset => INTERVAL '30 days',
  end_offset   => NULL,
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE);

ALTER MATERIALIZED VIEW cell_daily SET (timescaledb.materialized_only = false);
