import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { embed, toVector, docFor } from './embed.js';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:leafpeep@localhost:5433/leafpeep';
const remote = /sslmode=|tsdb\.cloud/.test(url);
// Tiger Cloud signs its certificates with its own CA (ca.timescale.com); verify against it rather than skipping checks.
const ca = /tsdb\.cloud/.test(url) ? readFileSync(new URL('../db/tiger-ca.pem', import.meta.url), 'utf8') : undefined;
export const pool = new pg.Pool({
  connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), // sslmode in the URL would override the ssl options below
  ssl: remote ? { ca, rejectUnauthorized: true } : undefined,
  max: 5,
});

// Idempotent: safe to run on every boot (local Timescale or Tiger Cloud).
export async function migrate() {
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  for (let i = 1; ; i++) {
    try { await pool.query(sql); return; } catch (err) {
      if (i >= 15) throw err;
      console.log(`database not ready (${err.code ?? err.message}), retrying…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ~1.1 km grid. Coarsening happens before anything is written, so exact GPS is never stored.
const CELL = 0.01;
export const toCell = (v) => Number((Math.round(v / CELL) * CELL).toFixed(2));

export async function insertSighting(s) {
  const doc = docFor(s);
  await pool.query(
    `INSERT INTO sightings (cell_lat, cell_lng, stage, color_score, colors, trees, scene, note, photo_key, model, embedding, search)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, to_tsvector('english', $12))`,
    [toCell(s.lat), toCell(s.lng), s.stage, s.colorScore, s.colors, s.trees, s.scene, s.note, s.photoKey, s.model,
      toVector(await embed(doc)), doc],
  );
}

// Fill in embeddings for rows written before search existed (or seeded by hand).
export async function backfillEmbeddings() {
  const { rows } = await pool.query(
    `SELECT time, cell_lat, cell_lng, trees, colors, scene, note FROM sightings WHERE embedding IS NULL LIMIT 500`);
  for (const r of rows) {
    const doc = docFor(r);
    await pool.query(
      `UPDATE sightings SET embedding = $1, search = to_tsvector('english', $2)
       WHERE time = $3 AND cell_lat = $4 AND cell_lng = $5 AND embedding IS NULL`,
      [toVector(await embed(doc)), doc, r.time, r.cell_lat, r.cell_lng]);
  }
  return rows.length;
}

// Hybrid search: rank spots by meaning (pgvector cosine distance) and by keywords (Postgres full-text),
// then fuse the two rankings with reciprocal rank fusion. Each spot comes back with its best-matching photo.
export async function searchCells(q, { days = 21, limit = 8 } = {}) {
  const v = toVector(await embed(q));
  // Any word may match; ts_rank rewards rows that match more of them.
  const GENERIC = new Set(['tree', 'trees', 'leaf', 'leaves', 'foliage', 'colour', 'color', 'colours', 'colors']);
  const words = q.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/)
    .filter((w) => w && !GENERIC.has(w.toLowerCase())).join(' OR ');
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT * FROM sightings WHERE time > now() - make_interval(days => $3) AND embedding IS NOT NULL
     ),
     vec AS (
       SELECT cell_lat, cell_lng, min(embedding <=> $1::vector) AS dist,
              row_number() OVER (ORDER BY min(embedding <=> $1::vector)) AS r
       FROM recent GROUP BY cell_lat, cell_lng
     ),
     kw AS (
       SELECT cell_lat, cell_lng, max(ts_rank(search, websearch_to_tsquery('english', $2))) AS rank,
              row_number() OVER (ORDER BY max(ts_rank(search, websearch_to_tsquery('english', $2))) DESC) AS r
       FROM recent WHERE search @@ websearch_to_tsquery('english', $2)
       GROUP BY cell_lat, cell_lng
     ),
     fused AS (
       SELECT coalesce(vec.cell_lat, kw.cell_lat) AS cell_lat, coalesce(vec.cell_lng, kw.cell_lng) AS cell_lng,
              coalesce(1.0 / (60 + vec.r), 0) + coalesce(1.0 / (60 + kw.r), 0) AS score,
              vec.dist, kw.rank AS kw_rank
       FROM vec FULL OUTER JOIN kw ON vec.cell_lat = kw.cell_lat AND vec.cell_lng = kw.cell_lng
     )
     SELECT f.*, b.trees, b.scene, b.note, b.photo_key, b.color_score, b.stage
     FROM fused f
     CROSS JOIN LATERAL (
       SELECT trees, scene, note, photo_key, color_score, stage FROM recent s
       WHERE s.cell_lat = f.cell_lat AND s.cell_lng = f.cell_lng
       ORDER BY s.embedding <=> $1::vector LIMIT 1
     ) b
     -- keep keyword hits, and vector hits that are actually close in meaning
     WHERE f.kw_rank IS NOT NULL OR f.dist < 0.62
     ORDER BY f.score DESC
     LIMIT $4`,
    [v, words || q, days, limit],
  );
  return rows;
}

// One row per grid cell with its current colour, trend and a forecast for when it peaks.
// The trend is a least-squares fit over the cell's daily averages (from the continuous aggregate).
const PEAK = 85;
export async function cellForecasts({ days = 21 } = {}) {
  const { rows } = await pool.query(
    `WITH d AS (
       SELECT cell_lat, cell_lng, day, score, photos
       FROM cell_daily
       WHERE day > now() - make_interval(days => $1)
     ),
     fit AS (
       SELECT cell_lat, cell_lng,
              regr_slope(score, extract(epoch FROM day) / 86400)  AS slope_per_day,
              count(*)                                          AS days_seen,
              sum(photos)                                       AS photos,
              max(score)                                        AS best
       FROM d GROUP BY cell_lat, cell_lng
     ),
     latest AS (
       SELECT DISTINCT ON (cell_lat, cell_lng) cell_lat, cell_lng, day AS last_day, score AS latest
       FROM d ORDER BY cell_lat, cell_lng, day DESC
     ),
     last_photo AS (
       SELECT DISTINCT ON (cell_lat, cell_lng) cell_lat, cell_lng, photo_key, note, trees, stage, time
       FROM sightings
       WHERE time > now() - make_interval(days => $1)
       ORDER BY cell_lat, cell_lng, time DESC
     )
     SELECT f.cell_lat, f.cell_lng, l.latest, l.last_day, f.slope_per_day, f.days_seen, f.photos, f.best,
            p.photo_key, p.note, p.trees, p.stage, p.time AS last_time
     FROM fit f
     JOIN latest l USING (cell_lat, cell_lng)
     LEFT JOIN last_photo p USING (cell_lat, cell_lng)`,
    [days],
  );
  return rows.map((r) => ({ ...r, forecast: forecast(r) }));
}

function forecast({ latest, slope_per_day: slope, days_seen, best, stage }) {
  if (stage === 'past' || (best >= PEAK && slope != null && slope < -1)) return { kind: 'past', label: 'Past peak' };
  if (latest >= PEAK) return { kind: 'peak', label: 'Peak now — go!' };
  if (days_seen < 2 || slope == null || slope <= 0.5) return { kind: 'unknown', label: 'Needs more photos to forecast' };
  const daysToPeak = Math.max(1, Math.round((PEAK - latest) / slope));
  if (daysToPeak > 30) return { kind: 'far', label: 'Peak is weeks away' };
  return { kind: 'soon', days: daysToPeak, label: `Peak in ~${daysToPeak} day${daysToPeak === 1 ? '' : 's'}` };
}
