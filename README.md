# Leaf Peep

**Where the colour is, this week.**

Snap a tree on your walk. An open-weight vision model (Gemma 4) reads how far its leaves have turned, and the photo lands on a shared map of where fall foliage is peaking. A Tiger Data hypertable keeps the colour history for each spot and forecasts when it will peak, so the next person knows where to walk this weekend.

Ten seconds on the screen, then back outside.

## How it works

```
phone camera ──► Express API ──► Gemma 4 (Ollama, on a DigitalOcean GPU Droplet)
                      │                 └─ returns stage, colour score 0–100, colours, tree guess
                      ├─► DigitalOcean Spaces   (photo, re-encoded so no EXIF/GPS survives)
                      └─► Tiger Data / TimescaleDB
                              sightings      hypertable, location rounded to a ~1 km cell
                              cell_daily     continuous aggregate: daily colour per cell
                              forecast       regr_slope over the daily series → "peak in ~N days"
```

- **Scoring:** `src/model.js` sends the photo to Gemma with a JSON schema, so the reply is always structured. It talks to Ollama's API by default, or any OpenAI-compatible endpoint with `MODEL_API=openai`.
- **Privacy:** the server re-encodes every photo, which strips EXIF and GPS, and stores only a ~1 km grid cell, never the exact location. Add `?at=lat,lng` to the URL to override the device location entirely.
- **Forecast:** `src/db.js` fits a least-squares trend to each cell's daily average colour and projects when it crosses the peak threshold (85).

## Run it locally

```bash
# 1. Open model
ollama pull gemma4

# 2. TimescaleDB
docker run -d --name leafpeep-db -p 5433:5432 \
  -e POSTGRES_PASSWORD=leafpeep -e POSTGRES_DB=leafpeep timescale/timescaledb:latest-pg17
docker exec -i leafpeep-db psql -U postgres -d leafpeep < db/schema.sql
# optional: synthetic history so the forecast has something to show (local only)
docker exec -i leafpeep-db psql -U postgres -d leafpeep < db/dev-seed.sql

# 3. App
npm install
npm run dev        # http://localhost:8080
```

Photos are saved to `./uploads` unless `SPACES_BUCKET` is set.

## Deploy on DigitalOcean

One Droplet runs Caddy (automatic HTTPS), the app and Ollama. Photos go to Spaces and data to Tiger Cloud.

```bash
cp .env.example .env            # fill in DATABASE_URL, SPACES_*, SITE
psql "$DATABASE_URL" -f db/schema.sql
cd deploy && docker compose up -d --build
docker compose exec ollama ollama pull gemma4
```

On a GPU Droplet, uncomment the `deploy.resources` block in `deploy/docker-compose.yml`.

## Stack

Gemma 4 · Ollama · DigitalOcean (GPU Droplet, Spaces) · Tiger Data (TimescaleDB) · Node + Express · Leaflet + MapLibre with OpenFreeMap tiles

## License

MIT
