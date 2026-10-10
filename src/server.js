import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { scorePhoto, stageFor } from './model.js';
import { savePhoto, photoUrl, localUploadsDir } from './storage.js';
import { insertSighting, cellForecasts, searchCells, backfillEmbeddings, pool, migrate } from './db.js';

const app = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.static('public'));
app.use('/uploads', express.static(localUploadsDir));

app.get('/healthz', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

// Every score costs a model call, so cap each visitor (a walker needs a handful an hour, not hundreds).
const LIMIT = Number(process.env.SCORES_PER_HOUR ?? 30);
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= LIMIT) {
    return res.status(429).json({ error: "That's a lot of trees for one hour. Enjoy the walk and try again later." });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}
// Behind a hosted proxy (Render, etc.) set TRUST_PROXY=1 so rate limiting sees the visitor's IP.
const tp = process.env.TRUST_PROXY;
app.set('trust proxy', tp ? (Number.isNaN(Number(tp)) ? tp : Number(tp)) : 'loopback, uniquelocal');

// Score one photo, store it, return the verdict.
app.post('/api/sightings', rateLimit, upload.single('photo'), async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!req.file) return res.status(400).json({ error: 'No photo attached.' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Location is needed to put your trees on the map.' });
  }

  // Re-encoding drops all metadata (EXIF, GPS) and shrinks the image for faster inference.
  const jpeg = await sharp(req.file.buffer).rotate().resize(896, 896, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();

  const t0 = Date.now();
  const verdict = await scorePhoto(jpeg);
  const ms = Date.now() - t0;
  if (!verdict.isFoliage) {
    return res.status(422).json({ error: "Couldn't spot any leaves in that one. Point the camera at a tree and try again.", ms });
  }

  const { key, url } = await savePhoto(jpeg);
  await insertSighting({ ...verdict, lat, lng, photoKey: key });
  res.json({ ...verdict, photo: url, ms });
});

app.get('/api/cells', async (_req, res) => {
  const cells = await cellForecasts();
  res.json(cells.map((c) => ({
    lat: c.cell_lat,
    lng: c.cell_lng,
    score: Math.round(c.latest),
    // The cell's stage follows its average colour; "past" comes from the latest photo since colour alone can't tell.
    stage: c.stage === 'past' ? 'past' : stageFor(c.latest),
    trees: c.trees,
    note: c.note,
    photos: Number(c.photos),
    lastSeen: c.last_time,
    photo: photoUrl(c.photo_key),
    forecast: c.forecast,
  })));
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 120);
  if (!q) return res.json([]);
  const rows = await searchCells(q);
  res.json(rows.map((r) => ({
    lat: r.cell_lat,
    lng: r.cell_lng,
    score: r.color_score,
    stage: r.stage,
    trees: r.trees,
    scene: r.scene,
    note: r.note,
    photo: photoUrl(r.photo_key),
    match: { vector: r.dist == null ? null : Number((1 - r.dist).toFixed(3)), keyword: r.kw_rank != null },
  })));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong scoring that photo. Try again in a moment.' });
});

await migrate();
backfillEmbeddings().then((n) => n && console.log(`embedded ${n} older sightings`)).catch(console.error);
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`Leaf Peep on http://localhost:${port}`));
