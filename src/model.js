// Scores a foliage photo with an open-weight vision model.
// MODEL_API=ollama  -> Ollama's native API (local Mac, or Ollama on a DigitalOcean Droplet)
// MODEL_API=openai  -> any OpenAI-compatible endpoint (DigitalOcean Gradient serverless inference, vLLM, ...)

const API = process.env.MODEL_API ?? 'ollama';
const BASE = process.env.MODEL_URL ?? 'http://localhost:11434';
const MODEL = process.env.MODEL_NAME ?? 'gemma4:latest';
const KEY = process.env.MODEL_KEY;

export const STAGES = ['green', 'turning', 'near_peak', 'peak', 'past'];

const SCHEMA = {
  type: 'object',
  properties: {
    is_foliage: { type: 'boolean' },
    stage: { type: 'string', enum: STAGES },
    color_score: { type: 'integer', minimum: 0, maximum: 100 },
    colors: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    trees: { type: 'string' },
    scene: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['is_foliage', 'stage', 'color_score', 'colors', 'trees', 'scene', 'note'],
};

const PROMPT = `You are a fall foliage spotter. Look at the trees in this photo and judge how far along their autumn colour change is.

color_score is the share of leaves that have changed from green to autumn colours (yellow, orange, red), from 0 to 100.
Light green, yellow-green and bright sunlit green are still green: a canopy that is all shades of green scores 0-10.
50 = about half the leaves have turned. 85+ = peak, almost every leaf is vivid yellow/orange/red.
Use stage "past" when leaves are mostly brown, dull or already fallen (score that by how much colour is left).
Estimate the share honestly; do not round up because the season is autumn.
stage: green (<15), turning (15-50), near_peak (50-85), peak (85+), or past.
colors: up to 4 plain colour words you actually see in the leaves.
trees: your best guess of the tree types, or "unknown".
scene: one plain, factual sentence describing the trees and their setting (e.g. "a row of tall maples along a lakeside path"), used for search.
note: one short, friendly sentence a walker would enjoy, under 20 words. No emoji.
is_foliage: true only for a real camera photograph of actual trees, leaves or plants. Set it false for drawings, cartoons, flat shapes, test patterns, screenshots, text, and photos with no real plants in them.

Reply with JSON only.`;

export async function scorePhoto(jpeg) {
  const b64 = jpeg.toString('base64');
  const raw = API === 'openai' ? await viaOpenAI(b64) : await viaOllama(b64);
  return normalize(JSON.parse(extractJson(raw)));
}

async function viaOllama(b64) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      keep_alive: '30m',
      format: SCHEMA,
      options: { temperature: 0.2 },
      messages: [{ role: 'user', content: PROMPT, images: [b64] }],
    }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  return (await res.json()).message.content;
}

async function viaOpenAI(b64) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(KEY && { authorization: `Bearer ${KEY}` }) },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: Number(process.env.MODEL_MAX_TOKENS ?? 400), // the JSON reply is ~150 tokens
      // Some providers (e.g. Google's Gemma endpoint) reject JSON mode; the reply is parsed either way.
      ...(process.env.MODEL_JSON_MODE !== 'false' && { response_format: { type: 'json_object' } }),
      // e.g. MODEL_REASONING=none skips the model's thinking step where the provider supports it (faster replies)
      ...(process.env.MODEL_REASONING && { reasoning_effort: process.env.MODEL_REASONING }),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

function extractJson(text) {
  // Some providers inline the model's reasoning as <thought>…</thought>; only the answer matters.
  text = String(text).replace(/<thought>[\s\S]*?<\/thought>/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`model returned no JSON: ${text.slice(0, 200)}`);
  return text.slice(start, end + 1);
}

function normalize(r) {
  const score = Math.max(0, Math.min(100, Math.round(Number(r.color_score) || 0)));
  return {
    isFoliage: r.is_foliage !== false,
    stage: STAGES.includes(r.stage) ? r.stage : stageFor(score),
    colorScore: score,
    colors: (Array.isArray(r.colors) ? r.colors : []).map(String).slice(0, 4),
    trees: String(r.trees ?? 'unknown').slice(0, 80),
    scene: String(r.scene ?? '').slice(0, 200),
    note: String(r.note ?? '').slice(0, 160),
    model: MODEL,
  };
}

export const stageFor = (s) => (s < 15 ? 'green' : s < 50 ? 'turning' : s < 85 ? 'near_peak' : 'peak');
