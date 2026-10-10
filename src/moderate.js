// Name moderation: an open-weight toxicity classifier (toxic-bert, in-process on CPU) plus a small blocklist
// for common slurs and obvious character swaps ("sh1t"). Returns null when the name is fine, or a reason.
import { pipeline } from '@huggingface/transformers';

let clf;
const load = () => (clf ??= pipeline('text-classification', 'Xenova/toxic-bert', { dtype: 'q8' }));
export const warmUpModeration = () => load();

// Per-label limits. Tuned so ordinary names (including "Dick Van Dyke") pass and real abuse doesn't.
const LIMITS = { toxic: 0.85, severe_toxic: 0.4, obscene: 0.7, threat: 0.5, insult: 0.6, identity_hate: 0.4 };

// Whole-word matches after normalising look-alike characters, so "Scunthorpe" or "Assam" never trip it.
const BLOCK = ['fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dickhead',
  'whore', 'slut', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'rapist', 'rape', 'nazi', 'hitler', 'kkk', 'porn', 'cock', 'pussy'];
const SWAPS = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't' };
const normalise = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[0134578@$!|+]/g, (c) => SWAPS[c]).replace(/(.)\1{2,}/g, '$1$1');

export async function checkName(name) {
  const norm = normalise(name);
  const words = norm.split(/[^a-z]+/).filter(Boolean);
  const joined = norm.replace(/[^a-z]/g, '');
  if (words.some((w) => BLOCK.includes(w)) || BLOCK.some((b) => b.length >= 5 && joined.includes(b))) return 'blocklist';
  const scores = Object.fromEntries((await (await load())([name, norm].join(' / '), { top_k: null })).map((r) => [r.label, r.score]));
  const hit = Object.entries(LIMITS).find(([label, limit]) => (scores[label] ?? 0) > limit);
  return hit ? `classifier:${hit[0]}` : null;
}

// For model-written text (notes, scene descriptions): same blocklist and classifier, slightly stricter.
export async function checkText(text) {
  if (!text) return null;
  return checkName(String(text).slice(0, 200));
}
