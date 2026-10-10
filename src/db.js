import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:leafpeep@localhost:5433/leafpeep';
export const pool = new pg.Pool({
  connectionString: url,
  ssl: /sslmode=require|tsdb\.cloud/.test(url) ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

// ~1.1 km grid. Coarsening happens before anything is written, so exact GPS is never stored.
const CELL = 0.01;
export const toCell = (v) => Number((Math.round(v / CELL) * CELL).toFixed(2));

export async function insertSighting(s) {
  await pool.query(
    `INSERT INTO sightings (cell_lat, cell_lng, stage, color_score, colors, trees, note, photo_key, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [toCell(s.lat), toCell(s.lng), s.stage, s.colorScore, s.colors, s.trees, s.note, s.photoKey, s.model],
  );
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
