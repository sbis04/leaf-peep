// Text embeddings with an open model (all-MiniLM-L6-v2, 384 dims), run in-process on CPU.
import { pipeline } from '@huggingface/transformers';

let extractor;
const load = () => (extractor ??= pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' }));

export async function embed(text) {
  const out = await (await load())(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

// pgvector literal
export const toVector = (v) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;

// The text we index for each sighting: what the tree is, its colours, and where it stands.
export const docFor = (s) => [s.trees, (s.colors ?? []).join(', '), s.scene, s.note].filter(Boolean).join('. ');

export const warmUp = () => load();
