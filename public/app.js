/* global L, exifr */
const $ = (id) => document.getElementById(id);

// ---------- colour scale ----------
const RAMP = [[0, '#5e7d4a'], [25, '#9a9a3a'], [50, '#e0a030'], [68, '#e0742b'], [85, '#c43d2a'], [100, '#a8301f']];
const PAST = '#8a6a4f';
function colorFor(score, stage) {
  if (stage === 'past') return PAST;
  for (let i = 1; i < RAMP.length; i++) {
    const [s1, c1] = RAMP[i - 1], [s2, c2] = RAMP[i];
    if (score <= s2) return mix(c1, c2, (score - s1) / (s2 - s1));
  }
  return RAMP.at(-1)[1];
}
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const STAGE_LABEL = { green: 'Still green', turning: 'Turning', near_peak: 'Near peak', peak: 'Peak', past: 'Past peak' };
const COLOR_WORDS = {
  red: '#c43d2a', crimson: '#a8233a', scarlet: '#d0342c', maroon: '#7a2430', burgundy: '#7a1f2b',
  orange: '#e0742b', rust: '#a8481f', copper: '#b8673a', amber: '#e0a030', gold: '#d9a521', golden: '#d9a521',
  yellow: '#e8c33a', 'yellow-green': '#a8b83a', 'light green': '#8fb36a', green: '#5e7d4a', 'dark green': '#3f5a33', olive: '#7d7d3a',
  brown: '#8a6a4f', tan: '#c2a27a', bronze: '#a0703a', purple: '#6e3a5e', pink: '#d97b8a',
};
const swatchFor = (w) => COLOR_WORDS[w.toLowerCase()] ?? COLOR_WORDS[w.toLowerCase().split(/\s|-/).pop()] ?? '#b9ad99';

// ---------- map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([40.7812, -73.9665], 12);
L.control.zoom({ position: 'topright' }).addTo(map);
// OpenFreeMap: open vector tiles, no API key. Dark mode tints the same style in CSS.
L.maplibreGL({
  style: 'https://tiles.openfreemap.org/styles/positron',
  attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
}).addTo(map);

const layer = L.layerGroup().addTo(map);
let me = null;
let meMarker = null;
let cells = [];

function locate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((p) => {
    me = { lat: p.coords.latitude, lng: p.coords.longitude };
    meMarker?.remove();
    meMarker = L.marker([me.lat, me.lng], { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [14, 14] }), interactive: false }).addTo(map);
    if (!cells.length) map.setView([me.lat, me.lng], 13);
    renderList();
  }, () => {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
}

async function loadCells({ fit = false } = {}) {
  cells = await fetch('/api/cells').then((r) => r.json());
  layer.clearLayers();
  for (const c of cells) {
    const color = colorFor(c.score, c.stage);
    const size = 18 + Math.min(c.photos, 12) * 2;
    const m = L.marker([c.lat, c.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="spot-marker ${c.forecast.kind === 'peak' ? 'peak' : ''}" style="width:${size}px;height:${size}px;background:${color}"></div>`,
        iconSize: [size, size],
      }),
    });
    m.bindPopup(popupHtml(c, color), { maxWidth: 240, minWidth: 240 });
    m.addTo(layer);
    c.marker = m;
  }
  if (fit && cells.length) map.fitBounds(L.latLngBounds(cells.map((c) => [c.lat, c.lng])).pad(0.3), { maxZoom: 14 });
  renderList();
}

function popupHtml(c, color) {
  const ago = timeAgo(c.lastSeen);
  return `<div class="pop">
    ${c.photo ? `<img src="${c.photo}" alt="Latest photo from this spot" loading="lazy">` : ''}
    <div class="pop-body">
      <div class="pop-head"><span class="pop-score" style="color:${color}">${c.score}</span>
        <span class="pop-fc">${esc(c.forecast.label)}</span></div>
      ${c.note ? `<p>${esc(c.note)}</p>` : ''}
      <p>${c.photos} photo${c.photos === 1 ? '' : 's'} · last ${ago}${c.trees && c.trees !== 'unknown' ? ` · ${esc(c.trees)}` : ''}</p>
    </div></div>`;
}

// Rank spots: peaking now first, then soonest to peak, nearest first within a group.
function renderList() {
  const list = $('spots');
  if (!cells.length) {
    list.innerHTML = '<li class="empty">No trees scored yet around here. Be the first.</li>';
    return;
  }
  const rank = { peak: 0, soon: 1, unknown: 2, far: 3, past: 4 };
  const sorted = [...cells].sort((a, b) =>
    rank[a.forecast.kind] - rank[b.forecast.kind]
    || (a.forecast.days ?? 0) - (b.forecast.days ?? 0)
    || dist(a) - dist(b));
  list.innerHTML = '';
  for (const c of sorted.slice(0, 6)) {
    const li = document.createElement('li');
    const d = dist(c);
    const km = me && d < 100 ? ` · ${d < 1 ? '<1' : d.toFixed(1)} km away` : '';
    const tree = c.trees && c.trees !== 'unknown' ? ` · ${c.trees}` : '';
    li.innerHTML = `<span class="dot" style="background:${colorFor(c.score, c.stage)}"></span>
      <span class="what">${esc(c.forecast.label)}<small>${esc((STAGE_LABEL[c.stage] ?? '') + tree + km)}</small></span>
      <span class="num">${c.score}</span>`;
    li.onclick = () => {
      map.flyTo([c.lat, c.lng], 15, { duration: 0.8 });
      setTimeout(() => c.marker.openPopup(), 850);
      if (innerWidth <= 820) $('panel').classList.add('collapsed');
    };
    list.append(li);
  }
}

function dist(c) {
  if (!me) return 0;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (c.lat - me.lat) * rad, dLng = (c.lng - me.lng) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(me.lat * rad) * Math.cos(c.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- capture flow ----------
$('captureBtn').onclick = () => $('photoInput').click();
$('photoInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const where = await whereWasThis(file);
    if (!where) return;
    await submit(file, where);
  } catch (err) {
    showError(err.message || 'Something went wrong.');
  }
};

// Location priority: the photo's own GPS (great for uploading later), then the device, then a tap on the map.
async function whereWasThis(file) {
  try {
    const gps = await exifr.gps(file);
    if (gps && Number.isFinite(gps.latitude)) return { lat: gps.latitude, lng: gps.longitude };
  } catch { /* no EXIF */ }
  const live = await new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => res(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 120000 });
  });
  if (live) return live;
  return pinOnMap();
}

function pinOnMap() {
  return new Promise((res) => {
    $('pinBanner').hidden = false;
    document.querySelector('.app').classList.add('pinning');
    $('panel').classList.add('collapsed');
    map.once('click', (e) => {
      $('pinBanner').hidden = true;
      document.querySelector('.app').classList.remove('pinning');
      res({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
  });
}

async function submit(file, where) {
  const small = await downscale(file, 1280);
  openResult(URL.createObjectURL(small));
  $('captureBtn').disabled = true;
  const body = new FormData();
  body.append('photo', small, 'photo.jpg');
  body.append('lat', where.lat);
  body.append('lng', where.lng);
  try {
    const res = await fetch('/api/sightings', { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not score that photo.');
    showVerdict(data);
    await loadCells();
    const cell = cells.find((c) => Math.abs(c.lat - Math.round(where.lat * 100) / 100) < 1e-6 && Math.abs(c.lng - Math.round(where.lng * 100) / 100) < 1e-6);
    map.flyTo([where.lat, where.lng], 14, { duration: 0.6 });
    if (cell) $('doneBtn').onclick = () => { closeResult(); setTimeout(() => cell.marker.openPopup(), 400); };
  } catch (err) {
    showError(err.message);
  } finally {
    $('captureBtn').disabled = false;
  }
}

async function downscale(file, max) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
}

// ---------- result sheet ----------
function openResult(src) {
  $('resultImg').parentElement.hidden = !src;
  if (src) $('resultImg').src = src; else $('resultImg').removeAttribute('src');
  $('resultStatus').className = 'result-status loading';
  $('resultStatus').textContent = 'Reading the leaves';
  $('scoreRow').hidden = true;
  $('swatches').innerHTML = '';
  $('note').textContent = '';
  $('trees').textContent = '';
  $('doneBtn').onclick = closeResult;
  $('result').showModal();
}

function showVerdict(v) {
  const color = colorFor(v.colorScore, v.stage);
  $('resultStatus').className = 'result-status';
  $('resultStatus').textContent = 'Added to the map';
  $('scoreRow').hidden = false;
  countUp($('score'), v.colorScore);
  $('score').style.color = color;
  $('stage').textContent = STAGE_LABEL[v.stage];
  $('stage').style.background = color;
  $('swatches').innerHTML = v.colors.map((w) => `<li><i style="background:${swatchFor(w)}"></i>${esc(w)}</li>`).join('');
  $('note').textContent = v.note;
  $('trees').textContent = v.trees && v.trees !== 'unknown' ? `Looks like ${v.trees.toLowerCase()}.` : '';
}

function showError(msg) {
  if (!$('result').open) openResult('');
  $('scoreRow').hidden = true;
  if (!$('resultImg').getAttribute('src')) $('resultImg').parentElement.hidden = true;
  $('resultStatus').className = 'result-status error';
  $('resultStatus').textContent = msg;
  $('doneBtn').textContent = 'Try another';
  $('doneBtn').onclick = () => { closeResult(); $('photoInput').click(); };
}

function closeResult() {
  $('result').close();
  $('doneBtn').textContent = 'Back to the walk';
}

function countUp(el, to) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 700);
    el.textContent = Math.round(to * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- bits ----------
function timeAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- theme ----------
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light');
const syncThemeBtn = () => {
  const t = currentTheme();
  $('themeBtn').dataset.mode = t;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', t === 'dark' ? '#16150f' : '#f3ede2'));
};
$('themeBtn').onclick = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  syncThemeBtn();
};
systemDark.addEventListener('change', syncThemeBtn);
syncThemeBtn();

$('panel').querySelector('.grip').onclick = () => $('panel').classList.toggle('collapsed');
map.on('dragstart', () => innerWidth <= 820 && $('panel').classList.add('collapsed'));

loadCells({ fit: true }).catch(() => {});
locate();
