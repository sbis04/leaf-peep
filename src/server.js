import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { scorePhoto } from './model.js';
import { savePhoto, photoUrl, localUploadsDir } from './storage.js';
import { insertSighting, cellForecasts, pool, migrate } from './db.js';

const app = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.static('public'));
app.use('/uploads', express.static(localUploadsDir));

app.get('/healthz', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

// Score one photo, store it, return the verdict.
app.post('/api/sightings', upload.single('photo'), async (req, res) => {
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
    stage: c.stage,
    trees: c.trees,
    note: c.note,
    photos: Number(c.photos),
    lastSeen: c.last_time,
    photo: photoUrl(c.photo_key),
    forecast: c.forecast,
  })));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong scoring that photo. Try again in a moment.' });
});

await migrate();
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`Leaf Peep on http://localhost:${port}`));
