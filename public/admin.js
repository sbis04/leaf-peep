const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STAGES = [
  ['green', 'Still green', '#5e7d4a'], ['turning', 'Turning', '#9a9a3a'], ['near_peak', 'Near peak', '#e0a030'],
  ['peak', 'Peak', '#c43d2a'], ['past', 'Past peak', '#8a6a4f'],
];
const RAMP = [[0, '#5e7d4a'], [25, '#9a9a3a'], [50, '#e0a030'], [68, '#e0742b'], [85, '#c43d2a'], [100, '#a8301f']];
function colorFor(score, stage) {
  if (stage === 'past') return '#8a6a4f';
  for (let i = 1; i < RAMP.length; i++) if (score <= RAMP[i][0]) return RAMP[i][1];
  return RAMP.at(-1)[1];
}

let token = '';
try { token = localStorage.getItem('lp.admin') || ''; } catch { /* storage blocked */ }
const auth = () => ({ authorization: `Bearer ${token}` });

// ---------- gate ----------
$('gate').onsubmit = async (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  const ok = await fetch('/api/admin/summary', { headers: auth() }).then((r) => r.ok).catch(() => false);
  if (!ok) { $('gateErr').hidden = false; return; }
  try { localStorage.setItem('lp.admin', token); } catch { /* keep in memory */ }
  start();
};
$('signout').onclick = () => {
  try { localStorage.removeItem('lp.admin'); } catch { /* ignore */ }
  location.reload();
};

// ---------- live stream (server-sent events over fetch, so the token stays in a header) ----------
let seen = new Set();
async function stream() {
  const live = (on, text) => { $('live').classList.toggle('on', on); $('liveText').textContent = text; };
  for (;;) {
    try {
      const res = await fetch('/api/admin/stream', { headers: auth() });
      if (res.status === 401) { $('dash').hidden = true; $('gate').hidden = false; live(false, 'Signed out'); return; }
      live(true, 'Live');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) render(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* network blip */ }
    live(false, 'Reconnecting…');
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function start() {
  $('gate').hidden = true;
  $('dash').hidden = false;
  stream();
}

// ---------- render ----------
function render(d) {
  const t = d.totals;
  const tile = (label, v, delta) => `<div class="tile"><div class="label">${label}</div><div class="v">${v ?? '–'}</div><div class="d">${delta}</div></div>`;
  $('tiles').innerHTML = [
    tile('Photos', t.photos, `+${t.photos_24h} in 24h`),
    tile('Walkers', t.walkers, `+${t.walkers_24h} in 24h`),
    tile('Likes', t.likes, `+${t.likes_24h} in 24h`),
    tile('Spots on the map', t.spots, '~1 km cells'),
    tile('Avg colour, 24h', t.avg_score_24h ?? '–', 'out of 100'),
  ].join('');

  barChart($('perHour'), d.perHour);
  stageBar($('stages'), d.stages);

  $('top').querySelector('tbody').innerHTML = d.top.length
    ? d.top.map((r, i) => `<tr><td>${i + 1}</td><td class="name">${esc(r.name)}</td><td class="num">${r.photos}</td><td class="num">${r.likes}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">No walkers yet.</td></tr>';

  const first = seen.size === 0;
  $('feed').innerHTML = d.recent.length ? d.recent.map((r) => {
    const fresh = !first && !seen.has(r.id);
    return `<article class="item ${fresh ? 'fresh' : ''}" data-id="${r.id}">
      ${r.photo ? `<img src="${esc(r.photo)}" alt="" loading="lazy">` : ''}
      <div class="meta">
        <div class="row"><span class="score" style="color:${colorFor(r.color_score, r.stage)}">${r.color_score}</span><span class="when">${ago(r.time)}</span></div>
        <div class="row"><span class="who">${esc(r.walker ?? 'unknown')}</span><span class="when">♥ ${r.likes}</span></div>
        <div class="when">${esc(r.trees ?? '')} · ${r.cell_lat.toFixed(2)}, ${r.cell_lng.toFixed(2)}</div>
        <button class="del" type="button" data-id="${r.id}">Delete</button>
      </div></article>`;
  }).join('') : '<p class="empty">No photos yet. They appear here the moment someone scores a tree.</p>';
  seen = new Set(d.recent.map((r) => r.id));
}

// Photos per hour: one series, one colour; hover a column for its exact count.
function barChart(el, rows) {
  const W = 640, H = 220, padL = 28, padB = 22, padT = 8;
  const max = Math.max(4, ...rows.map((r) => r.photos));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const bw = (W - padL) / rows.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const ticks = [0, 1, 2, 3, 4].map((k) => k * step);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Photos per hour over the last 24 hours">
    <g class="grid">${ticks.map((v) => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}</g>
    <g class="axis">${ticks.map((v) => `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      ${rows.map((r, i) => (i % 6 === 0 ? `<text x="${padL + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${hour(r.hour)}</text>` : '')).join('')}</g>
    ${rows.map((r, i) => {
      const x = padL + i * bw + 2, w = Math.max(2, bw - 4), h = H - padB - y(r.photos);
      return `<g class="col" data-tip="${hour(r.hour)} · ${r.photos} photo${r.photos === 1 ? '' : 's'}">
        <rect class="hit" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}"/>
        ${r.photos ? `<path class="bar" d="M${x},${H - padB} v${-(h - 3)} q0,-3 3,-3 h${w - 6} q3,0 3,3 v${h - 3} z"/>` : ''}</g>`;
    }).join('')}
  </svg>`;
}

// Stage mix: ordered green → past on the foliage ramp, every segment labelled in the list below.
function stageBar(el, rows) {
  const n = Object.fromEntries(rows.map((r) => [r.stage, r.n]));
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) { el.innerHTML = '<p class="empty">No photos in the last 7 days.</p>'; return; }
  el.innerHTML = `<div class="stagebar" role="img" aria-label="Stage mix">${STAGES.filter(([k]) => n[k]).map(([k, label, c]) =>
    `<span style="flex:${n[k]};background:${c}" data-tip="${label} · ${n[k]}"></span>`).join('')}</div>
    <ul class="stagelist">${STAGES.map(([k, label, c]) => `<li><i style="background:${c}"></i><span>${label}</span>
      <span class="n">${n[k] ?? 0}</span><span class="p">${Math.round(((n[k] ?? 0) / total) * 100)}%</span></li>`).join('')}</ul>`;
}

// ---------- tooltips ----------
document.addEventListener('pointermove', (e) => {
  const t = e.target.closest('[data-tip]');
  const tip = $('tip');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.style.left = `${e.clientX}px`;
  tip.style.top = `${e.clientY}px`;
  tip.hidden = false;
});

// ---------- delete (two taps: arm, then confirm) ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.del');
  if (!btn) return;
  if (!btn.classList.contains('arm')) {
    btn.classList.add('arm');
    btn.textContent = 'Tap again to delete';
    setTimeout(() => { btn.classList.remove('arm'); btn.textContent = 'Delete'; }, 3500);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  const ok = await fetch(`/api/admin/sightings/${btn.dataset.id}`, { method: 'DELETE', headers: auth() }).then((r) => r.ok).catch(() => false);
  if (!ok) { btn.disabled = false; btn.textContent = 'Failed, retry'; }
});

const hour = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric' });
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

if (token) start(); else $('gate').hidden = false;
