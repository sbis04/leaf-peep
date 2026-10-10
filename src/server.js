import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { scorePhoto, stageFor } from './model.js';
import { warmUp } from './embed.js';
import { checkName, checkText, warmUpModeration } from './moderate.js';
import { savePhoto, deletePhoto, photoUrl, localUploadsDir } from './storage.js';
import {
  insertSighting, cellForecasts, searchCells, backfillEmbeddings, pool, migrate,
  upsertWalker, getWalker, toggleLike, leaderboard, deleteSighting, adminSummary, setPhotoApproved,
  hit, countHits, walkerHasPhoto,
} from './db.js';

const app = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });
const events = new EventEmitter(); // 'change' whenever photos or likes change; feeds the admin stream

// Cache busting: every deploy gets a new BUILD id. Pages are never cached; they reference app.js/style.css/admin.*
// with ?v=BUILD so browsers (and Home Screen apps) always fetch the new code after a deploy.
import { readFileSync as readSync, statSync } from 'node:fs';
const BUILD = process.env.BUILD_ID || String(Math.max(...['public/app.js', 'public/style.css', 'public/admin.js', 'public/admin.css']
  .map((f) => statSync(f).mtimeMs | 0)).toString(36));
const page = (file) => (req, res) => {
  const html = readSync(`public/${file}`, 'utf8').replace(/(\/(?:app|demo|admin)\.js|\/(?:style|admin)\.css)(?=["'])/g, `$1?v=${BUILD}`);
  res.set('cache-control', 'no-cache').type('html').send(html);
};
app.get(['/', '/index.html'], page('index.html'));
app.get(['/admin', '/admin.html'], page('admin.html'));
app.use(express.static('public', {
  extensions: ['html'],
  setHeaders: (res, file) => {
    // versioned code can be cached for a year; everything else revalidates (cheap 304 via ETag)
    const versioned = /\.(js|css)$/.test(file) && /[?&]v=/.test(res.req.originalUrl);
    res.set('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
}));
app.use('/uploads', express.static(localUploadsDir));
app.use(express.json({ limit: '4kb' }));

app.get('/healthz', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

// Behind a hosted proxy (Render, etc.) set TRUST_PROXY=1 so rate limiting sees the visitor's IP.
const tp = process.env.TRUST_PROXY;
app.set('trust proxy', tp ? (Number.isNaN(Number(tp)) ? tp : Number(tp)) : 'loopback, uniquelocal');

// Limits live in the database (rate_hits) so a restart or redeploy doesn't reset them.
function limiter(name, perHour, message) {
  return async (req, res, next) => {
    try {
      if ((await hit(`${name}:${req.ip}`, 3600)) > perHour) return res.status(429).json({ error: message });
      next();
    } catch (err) { next(err); }
  };
}
const scoreLimit = limiter('score', Number(process.env.SCORES_PER_HOUR ?? 30), "That's a lot of trees for one hour. Enjoy the walk and try again later.");
const likeLimit = limiter('like', 300, 'Easy there. Try again in a bit.');

// Daily budget across everyone: every score is a paid model call, so the total per day is capped.
const DAILY_SCORES = Number(process.env.DAILY_SCORE_BUDGET ?? 500);
const LIKES_PER_WALKER_DAY = Number(process.env.LIKES_PER_WALKER_DAY ?? 100);
const NEW_WALKERS_PER_DAY = Number(process.env.NEW_WALKERS_PER_DAY ?? 3);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUID.test(v);

// Any name the walker likes, within reason: printable, single-spaced, 1 to 32 characters.
function cleanName(raw) {
  const name = String(raw ?? '').normalize('NFC').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= 32 ? name : null;
}

// ---------- walkers ----------
app.post('/api/walkers', limiter('walker', 20, 'Too many name changes. Try again later.'), async (req, res) => {
  const { id } = req.body ?? {};
  const name = cleanName(req.body?.name);
  if (!isId(id)) return res.status(400).json({ error: 'Bad walker id.' });
  if (!name) return res.status(400).json({ error: 'Pick a name between 1 and 32 characters.' });
  const why = await checkName(name);
  if (why) {
    console.log(`name rejected (${why})`);
    return res.status(422).json({ error: "Let's keep it friendly. Please pick a different name.", code: 'name_rejected' });
  }
  // A few new walkers per network per day, so scripts can't mint likers or flood the leaderboard.
  if (!(await getWalker(id)) && (await hit(`newwalker:${req.ip}`, 86400)) > NEW_WALKERS_PER_DAY) {
    return res.status(429).json({ error: 'Too many new names from here today. Try again tomorrow.' });
  }
  res.json(await upsertWalker(id, name));
});

app.get('/api/walkers/:id', async (req, res) => {
  const w = isId(req.params.id) ? await getWalker(req.params.id) : null;
  return w ? res.json(w) : res.status(404).json({ error: 'Unknown walker.' });
});

// ---------- scoring ----------
app.post('/api/sightings', scoreLimit, upload.single('photo'), async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const walkerId = req.body.walker_id;
  if (!req.file) return res.status(400).json({ error: 'No photo attached.' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Location is needed to put your trees on the map.' });
  }
  if (!isId(walkerId) || !(await getWalker(walkerId))) {
    return res.status(400).json({ error: 'Pick a name first.', code: 'name_required' });
  }

  if ((await countHits('budget:score', 86400)) >= DAILY_SCORES) {
    return res.status(503).json({ error: "It's a busy day for Leaf Peep, so scoring is paused until tomorrow. The map, likes and search still work.", code: 'budget' });
  }
  await hit('budget:score', 86400);

  // Re-encoding drops all metadata (EXIF, GPS). The model gets a small copy (fewer image tokens, faster reply);
  // the map keeps a sharper one for people to look at.
  const t = { start: Date.now() };
  const base = sharp(req.file.buffer).rotate();
  const [forModel, jpeg] = await Promise.all([
    base.clone().resize(640, 640, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer(),
    base.clone().resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer(),
  ]);
  t.resized = Date.now();
  const verdict = await scorePhoto(forModel);
  t.scored = Date.now();
  const ms = t.scored - t.resized;
  if (!verdict.isFoliage) {
    return res.status(422).json({ error: "Couldn't spot any leaves in that one. Point the camera at a tree and try again.", ms });
  }

  // Gemma's own words are checked too, so text hidden in a photo can't put something nasty on the map.
  if (await checkText(verdict.note)) verdict.note = 'A tree worth a look on your walk.';
  if (await checkText(verdict.scene)) verdict.scene = 'trees';
  // The photo is kept for moderation only: it's never in any public response, just the admin dashboard.
  const { key } = await savePhoto(jpeg);
  const row = await insertSighting({ ...verdict, lat, lng, photoKey: key, walkerId });
  t.saved = Date.now();
  console.log(`score ${verdict.colorScore} · upload ${req.file.size >> 10} KB · resize ${t.resized - t.start} ms · model ${ms} ms · save+embed ${t.saved - t.scored} ms`);
  events.emit('change');
  res.json({ ...verdict, id: row.id, ms });
});

// ---------- map, likes, leaderboard, search ----------
app.get('/api/cells', async (req, res) => {
  const me = isId(req.query.me) ? req.query.me : null;
  const cells = await cellForecasts({ me });
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
    colors: c.colors ?? [],
    // only photos an admin has approved are ever public
    photo: c.photo_approved ? photoUrl(c.photo_key) : null,
    sighting: c.sighting_id,
    by: c.walker,
    likes: c.likes,
    liked: c.liked,
    forecast: c.forecast,
  })));
});

app.post('/api/likes', likeLimit, async (req, res) => {
  const { sighting_id: sightingId, walker_id: walkerId } = req.body ?? {};
  if (!isId(sightingId) || !isId(walkerId)) return res.status(400).json({ error: 'Bad request.' });
  // Only real walkers can like: a name and at least one scored photo. Stops scripts inventing likers.
  if (!(await getWalker(walkerId)) || !(await walkerHasPhoto(walkerId))) {
    return res.status(403).json({ error: 'Score a tree first, then you can like other walkers\' trees.', code: 'walker_required' });
  }
  if ((await hit(`likes:${walkerId}`, 86400)) > LIKES_PER_WALKER_DAY) {
    return res.status(429).json({ error: 'That is a lot of likes for one day. Try again tomorrow.' });
  }
  const result = await toggleLike(sightingId, walkerId);
  events.emit('change');
  res.json(result);
});

app.get('/api/leaderboard', async (_req, res) => {
  res.json(await leaderboard(10));
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
    colors: r.colors ?? [],
    match: { vector: r.dist == null ? null : Number((1 - r.dist).toFixed(3)), keyword: r.kw_rank != null },
  })));
});

// ---------- admin (ADMIN_TOKEN required; disabled when unset) ----------
const ADMIN = process.env.ADMIN_TOKEN ?? '';
function admin(req, res, next) {
  const given = Buffer.from(String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(ADMIN);
  if (ADMIN.length < 16 || given.length !== want.length || !timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Not authorised.' });
  }
  next();
}

const withPhotos = (summary) => ({ ...summary, recent: summary.recent.map((r) => ({ ...r, photo: photoUrl(r.photo_key) })) });

app.get('/api/admin/summary', admin, async (_req, res) => {
  res.json(withPhotos(await adminSummary()));
});

// Server-sent events: a fresh summary on every change (debounced) and every 30 s.
app.get('/api/admin/stream', admin, async (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  let timer = null;
  const send = async () => {
    timer = null;
    try { res.write(`data: ${JSON.stringify(withPhotos(await adminSummary()))}\n\n`); } catch (err) { console.error(err); }
  };
  const soon = () => { timer ??= setTimeout(send, 400); };
  events.on('change', soon);
  const tick = setInterval(send, 30_000);
  send();
  req.on('close', () => { events.off('change', soon); clearInterval(tick); clearTimeout(timer); });
});

app.post('/api/admin/sightings/:id/approve', admin, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
  const ok = await setPhotoApproved(req.params.id, req.body?.approved !== false);
  events.emit('change');
  res.json({ ok });
});

app.delete('/api/admin/sightings/:id', admin, async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
  const key = await deleteSighting(req.params.id);
  if (key) await deletePhoto(key).catch(console.error);
  events.emit('change');
  res.json({ deleted: Boolean(key) });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
});

await migrate();
warmUp().then(() => console.log('embedding model ready')).catch(console.error); // avoid a slow first score
warmUpModeration().then(() => console.log('moderation model ready')).catch(console.error);
backfillEmbeddings().then((n) => n && console.log(`embedded ${n} older sightings`)).catch(console.error);
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`Leaf Peep on http://localhost:${port}`));
