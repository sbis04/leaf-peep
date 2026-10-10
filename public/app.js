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

// ---------- iPhone Safari tab: one-time hint to add to the Home Screen for full screen ----------
const iosTab = /iPhone|iPod/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
if (iosTab && !/[?&](fakecam|demo|fresh)=?/.test(location.search)) {
  let seen = false;
  try { seen = localStorage.getItem('lp.a2hs') === '1'; } catch { /* storage blocked */ }
  if (!seen) {
    const tip = document.createElement('div');
    tip.className = 'a2hs';
    tip.innerHTML = '<span>For full screen, tap <b>Share</b> then <b>Add to Home Screen</b>.</span><button type="button" aria-label="Dismiss">✕</button>';
    tip.querySelector('button').onclick = () => { tip.remove(); try { localStorage.setItem('lp.a2hs', '1'); } catch { /* ignore */ } };
    setTimeout(() => document.body.append(tip), 2500);
  }
}

// ---------- anonymous walker ----------
// A random id lives on this device; a name is asked for only before the first photo. No account, no email.
const walker = (() => {
  let w = null;
  if (new URLSearchParams(location.search).has('fresh')) { try { localStorage.removeItem('lp.walker'); } catch { /* ignore */ } }
  try { w = JSON.parse(localStorage.getItem('lp.walker') || 'null'); } catch { /* storage blocked */ }
  if (!w?.id) w = { id: crypto.randomUUID(), name: null };
  return w;
})();
function saveWalker() {
  try { localStorage.setItem('lp.walker', JSON.stringify(walker)); } catch { /* private mode: keep it in memory */ }
}
saveWalker();

function askName() {
  return new Promise((resolve) => {
    const dlg = $('namer');
    $('nameInput').value = walker.name ?? '';
    $('nameError').hidden = true;
    const done = (v) => { dlg.close(); resolve(v); };
    $('nameCancel').onclick = () => done(false);
    $('namerForm').onsubmit = async (e) => {
      e.preventDefault();
      const name = $('nameInput').value.replace(/\s+/g, ' ').trim();
      if (!name) return;
      $('nameSave').disabled = true;
      try {
        const res = await fetch('/api/walkers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: walker.id, name }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save that name.');
        walker.name = data.name;
        saveWalker();
        done(true);
      } catch (err) {
        $('nameError').textContent = err.message;
        $('nameError').hidden = false;
      } finally {
        $('nameSave').disabled = false;
      }
    };
    dlg.showModal();
    // iOS slides the page up when the keyboard opens; keep the sheet pinned to the visible area.
    const vv = window.visualViewport;
    const follow = () => { dlg.style.transform = vv ? `translateY(${vv.offsetTop}px)` : ''; };
    vv?.addEventListener('resize', follow);
    vv?.addEventListener('scroll', follow);
    dlg.addEventListener('close', () => { vv?.removeEventListener('resize', follow); vv?.removeEventListener('scroll', follow); dlg.style.transform = ''; }, { once: true });
    setTimeout(() => $('nameInput').focus(), 50);
  });
}

// ---------- map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([40.7812, -73.9665], 12);
L.control.zoom({ position: 'topright' }).addTo(map);
// OpenFreeMap: open vector tiles, no API key. Dark mode tints the same style in CSS.
L.maplibreGL({
  style: 'https://tiles.openfreemap.org/styles/positron',
  attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
}).addTo(map);

const layer = L.layerGroup().addTo(map);

// On mobile the bottom sheet covers the lower part of the map; aim at the visible part instead.
function centerOn(lat, lng, zoom, fly = false) {
  const sheet = innerWidth <= 820 ? $('panel').offsetHeight : 0;
  const target = map.project([lat, lng], zoom).add([0, sheet / 2]);
  const ll = map.unproject(target, zoom);
  fly ? map.flyTo(ll, zoom, { duration: 0.8 }) : map.setView(ll, zoom);
}
let me = null;
let meMarker = null;
let cells = [];
let userMoved = false;
map.on('dragstart zoomstart', (e) => { if (e.originalEvent || e.type === 'dragstart') userMoved = true; });

// ?at=lat,lng stands in for the device location (demos, testing, privacy).
const AT = (() => {
  const m = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
  return m?.length === 2 && m.every(Number.isFinite) ? { lat: m[0], lng: m[1] } : null;
})();
function deviceLocation(opts) {
  if (AT) return Promise.resolve(AT);
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), opts);
  });
}

function locate() {
  deviceLocation({ enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }).then((loc) => {
    if (!loc) return;
    me = loc;
    meMarker?.remove();
    meMarker = L.marker([me.lat, me.lng], { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [14, 14] }), interactive: false }).addTo(map);
    // Start where the user is; that's where they'll walk.
    if (!userMoved) centerOn(me.lat, me.lng, 13);
    renderList();
  });
}

let knownCells = null;
async function loadCells({ fit = false } = {}) {
  cells = await fetch(`/api/cells?me=${walker.id}`).then((r) => r.json());
  const seen = knownCells;
  knownCells = new Set(cells.map((c) => `${c.lat},${c.lng}`));
  layer.clearLayers();
  for (const c of cells) {
    const color = colorFor(c.score, c.stage);
    const size = 18 + Math.min(c.photos, 12) * 2;
    const m = L.marker([c.lat, c.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="spot-marker ${c.forecast.kind === 'peak' ? 'peak' : ''} ${seen && !seen.has(`${c.lat},${c.lng}`) ? 'fresh' : ''}" style="width:${size}px;height:${size}px;background:${color}"></div>`,
        iconSize: [size, size],
      }),
    });
    m.bindPopup(popupHtml(c, color), { maxWidth: 240, minWidth: 240, autoPanPaddingTopLeft: [12, 70], autoPanPaddingBottomRight: [12, 24] });
    m.addTo(layer);
    c.marker = m;
  }
  if (fit && cells.length && !me) map.fitBounds(L.latLngBounds(cells.map((c) => [c.lat, c.lng])).pad(0.3), { maxZoom: 14 });
  results ? showResults() : renderList();
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
      <div class="pop-foot">
        <span class="pop-by">${c.by ? `by ${esc(c.by)}` : ''}</span>
        ${c.sighting ? `<button class="like ${c.liked ? 'on' : ''}" type="button" data-sighting="${c.sighting}" aria-pressed="${c.liked}" aria-label="Like this photo">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 6.9 4.5c2 0 3.6 1.1 5.1 3 1.5-1.9 3.1-3 5.1-3 3.5 0 5.5 3.5 4.2 6.8-1.8 4.6-9.3 9.2-9.3 9.2Z"/></svg>
          <span>${c.likes || ''}</span></button>` : ''}
      </div>
    </div></div>`;
}

// ---------- likes ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.like');
  if (!btn) return;
  btn.disabled = true;
  try {
    const res = await fetch('/api/likes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sighting_id: btn.dataset.sighting, walker_id: walker.id }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    btn.classList.toggle('on', data.liked);
    btn.setAttribute('aria-pressed', data.liked);
    btn.querySelector('span').textContent = data.likes || '';
    const c = cells.find((x) => x.sighting === btn.dataset.sighting);
    if (c) { c.liked = data.liked; c.likes = data.likes; c.marker.setPopupContent(popupHtml(c, colorFor(c.score, c.stage))); }
    loadLeaders();
  } catch { /* leave it as it was */ } finally {
    btn.disabled = false;
  }
});

// ---------- leaderboard ----------
async function loadLeaders() {
  const rows = await fetch('/api/leaderboard').then((r) => r.json()).catch(() => []);
  const list = $('leaders');
  if (!rows.length) {
    list.innerHTML = '<li class="empty">No walkers yet. Score a tree to get on the board.</li>';
    return;
  }
  list.innerHTML = rows.map((r, i) => `<li class="${r.name === walker.name ? 'you' : ''}">
    <span class="rank">${i + 1}</span>
    <span class="who">${esc(r.name)}${r.name === walker.name ? ' <small>you</small>' : ''}</span>
    <span class="stat"><b>${r.photos}</b> photo${r.photos === 1 ? '' : 's'}</span>
    <span class="stat heart">♥ ${r.likes}</span></li>`).join('');
}

// ---------- search (hybrid keyword + vector, served from Tiger Data) ----------
let results = null;
$('findForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('findInput').value.trim();
  if (!q) return clearSearch();
  $('findInput').blur();
  $('listTitle').textContent = 'Searching…';
  const found = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
  results = { q, found };
  $('findClear').hidden = false;
  showResults();
};
$('findClear').onclick = clearSearch;
$('findInput').oninput = () => { $('findClear').hidden = !$('findInput').value; if (!$('findInput').value && results) clearSearch(); };

function clearSearch() {
  results = null;
  $('findInput').value = '';
  $('findClear').hidden = true;
  for (const c of cells) c.marker?.getElement()?.firstElementChild?.classList.remove('dim');
  renderList();
}

function showResults() {
  const { q, found } = results;
  const key = (c) => `${c.lat},${c.lng}`;
  const hit = new Set(found.map(key));
  for (const c of cells) c.marker?.getElement()?.firstElementChild?.classList.toggle('dim', !hit.has(key(c)));
  $('listTitle').textContent = found.length ? `Matches for “${q}”` : `Nothing like “${q}” yet`;
  const list = $('spots');
  list.innerHTML = found.length ? '' : '<li class="empty">Try a tree, a colour or a place: “golden path”, “maples by a lake”.</li>';
  for (const r of found) {
    const c = cells.find((x) => key(x) === key(r));
    const why = [r.match.keyword && 'words', r.match.vector != null && r.match.vector >= 0.38 && 'meaning'].filter(Boolean).join(' + ');
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${colorFor(r.score, r.stage)}"></span>
      <span class="what">${esc(r.trees && r.trees !== 'unknown' ? r.trees : 'Trees')}<small>${esc(r.scene || r.note || '')}</small>
      ${why ? `<span class="why">matched on ${why}</span>` : ''}</span>
      <span class="num">${r.score}</span>`;
    li.onclick = () => focusCell(c ?? r);
    list.append(li);
  }
  if (found.length) {
    const b = L.latLngBounds(found.map((r) => [r.lat, r.lng]));
    found.length === 1 ? centerOn(found[0].lat, found[0].lng, 15, true) : map.flyToBounds(b.pad(0.4), { maxZoom: 15, duration: 0.8 });
  }
}

function focusCell(c) {
  if (mobile()) setSheet('peek');
  setTimeout(() => centerOn(c.lat, c.lng, 15, true), innerWidth <= 820 ? 320 : 0);
  if (c.marker) setTimeout(() => c.marker.openPopup(), 1200);
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
    li.onclick = () => focusCell(c);
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
let stream = null;
$('captureBtn').onclick = async () => {
  if (!walker.name && !(await askName())) return;
  openCamera();
};

// ?fakecam=<video url>: demo/recording only. Plays a looping clip as the viewfinder; shutter and scoring stay real.
const FAKECAM = new URLSearchParams(location.search).get('fakecam');

async function openCamera() {
  if (FAKECAM && FAKECAM.startsWith('/demo/')) {
    const v = $('cameraVideo');
    v.srcObject = null;
    v.src = FAKECAM;
    v.loop = true;
    $('camera').classList.remove('nocam');
    $('camera').showModal();
    v.play().catch(() => {});
    return;
  }
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera api');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
    });
    $('cameraVideo').srcObject = stream;
    $('camera').classList.remove('nocam');
    $('camera').showModal();
  } catch {
    // No live camera (denied, simulator, old browser). Browsers only open the file picker from a direct tap,
    // so show the camera sheet with its Upload button instead of trying to open the picker from code.
    $('camera').classList.add('nocam');
    $('camera').showModal();
  }
}

function closeCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('cameraVideo').srcObject = null;
  if (FAKECAM) { $('cameraVideo').pause(); $('cameraVideo').removeAttribute('src'); }
  if ($('camera').open) $('camera').close();
}
$('cameraClose').onclick = closeCamera;
$('camera').addEventListener('cancel', closeCamera);
$('cameraUpload').onclick = () => $('libraryInput').click();

$('shutter').onclick = async () => {
  const v = $('cameraVideo');
  if (!v.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  $('camera').classList.add('flash');
  setTimeout(() => $('camera').classList.remove('flash'), 180);
  closeCamera();
  handlePhoto(new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
};

for (const id of ['photoInput', 'libraryInput']) {
  $(id).onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    closeCamera();
    handlePhoto(file);
  };
}

async function handlePhoto(file) {
  try {
    const where = await whereWasThis(file);
    if (!where) return;
    await submit(file, where);
  } catch (err) {
    showError(err.message || 'Something went wrong.');
  }
}

// Location priority: the photo's own GPS (great for uploading later), then the device, then a tap on the map.
async function whereWasThis(file) {
  if (AT) return AT; // an explicit override beats the photo's own GPS too
  try {
    const gps = await exifr.gps(file);
    if (gps && Number.isFinite(gps.latitude)) return { lat: gps.latitude, lng: gps.longitude };
  } catch { /* no EXIF */ }
  const live = await deviceLocation({ enableHighAccuracy: true, timeout: 10000, maximumAge: 120000 });
  if (live) return live;
  return pinOnMap();
}

function pinOnMap() {
  return new Promise((res) => {
    $('pinBanner').hidden = false;
    document.querySelector('.app').classList.add('pinning');
    setSheet('peek');
    map.once('click', (e) => {
      $('pinBanner').hidden = true;
      document.querySelector('.app').classList.remove('pinning');
      res({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
  });
}

async function submit(file, where) {
  const small = await downscale(file, 1024);
  openResult(URL.createObjectURL(small));
  $('captureBtn').disabled = true;
  const body = new FormData();
  body.append('photo', small, 'photo.jpg');
  body.append('lat', where.lat);
  body.append('lng', where.lng);
  body.append('walker_id', walker.id);
  try {
    const res = await fetch('/api/sightings', { method: 'POST', body });
    const data = await res.json();
    if (data.code === 'name_required') {
      closeResult();
      walker.name = null;
      if (await askName()) return submit(file, where);
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Could not score that photo.');
    showVerdict(data);
    await loadCells();
    loadLeaders();
    const cell = cells.find((c) => Math.abs(c.lat - Math.round(where.lat * 100) / 100) < 1e-6 && Math.abs(c.lng - Math.round(where.lng * 100) / 100) < 1e-6);
    centerOn(where.lat, where.lng, 14, true);
    if (cell) $('doneBtn').onclick = () => { closeResult(); focusCell(cell); };
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
  $('resultPhoto').classList.toggle('scanning', !!src);
  $('byline').textContent = '';
  $('scoreRow').hidden = true;
  $('swatches').innerHTML = '';
  $('note').textContent = '';
  $('trees').textContent = '';
  $('doneBtn').onclick = closeResult;
  $('result').showModal();
  $('doneBtn').blur(); // showModal focuses the first button; don't paint a focus ring on open
}

function showVerdict(v) {
  const color = colorFor(v.colorScore, v.stage);
  $('resultPhoto').classList.remove('scanning');
  $('byline').textContent = `Scored by ${v.model.replace(/:latest$/, '')} · ${(v.ms / 1000).toFixed(1)} s`;
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
  $('resultPhoto').classList.remove('scanning');
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
};
$('themeBtn').onclick = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  syncThemeBtn();
};
systemDark.addEventListener('change', syncThemeBtn);
syncThemeBtn();

// ---------- bottom sheet (phones): drag the grip or header between peek, half and full ----------
const mobile = () => innerWidth <= 820;
const screenH = () => (matchMedia('(display-mode: standalone)').matches ? Math.max(innerHeight, screen.height) : innerHeight);
const snaps = () => ({ peek: 190, half: Math.round(screenH() * 0.52), full: Math.round(screenH() * 0.88) });
let sheet = 'half';
function setSheet(state) {
  if (!mobile()) return;
  sheet = state;
  const panel = $('panel');
  panel.style.setProperty('--sheet-h', `${snaps()[state]}px`);
  panel.classList.toggle('collapsed', state === 'peek');
  if (state === 'peek') panel.scrollTop = 0;
}
(() => {
  const panel = $('panel');
  let drag = null;
  const start = (e) => {
    if (!mobile() || e.target.closest('button, a, input')) return;
    drag = { y: e.clientY, h: panel.getBoundingClientRect().height, t: performance.now(), lastY: e.clientY, lastT: performance.now(), moved: false };
    panel.classList.add('dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 4) drag.moved = true;
    const { peek, full } = snaps();
    panel.style.setProperty('--sheet-h', `${Math.max(peek - 40, Math.min(full + 20, drag.h - dy))}px`);
    drag.v = (e.clientY - drag.lastY) / Math.max(1, performance.now() - drag.lastT); // px per ms, + is downward
    drag.lastY = e.clientY; drag.lastT = performance.now();
  };
  const end = () => {
    if (!drag) return;
    panel.classList.remove('dragging');
    const h = panel.getBoundingClientRect().height;
    const order = ['peek', 'half', 'full'];
    let next;
    if (!drag.moved) next = sheet === 'peek' ? 'half' : 'peek'; // a tap toggles
    else if (Math.abs(drag.v ?? 0) > 0.45) next = order[Math.max(0, Math.min(2, order.indexOf(sheet) + (drag.v > 0 ? -1 : 1)))]; // flick
    else next = order.reduce((a, k) => (Math.abs(snaps()[k] - h) < Math.abs(snaps()[a] - h) ? k : a), 'half');
    drag = null;
    setSheet(next);
  };
  for (const el of [panel.querySelector('.grip'), panel.querySelector('.brand')]) {
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  addEventListener('resize', () => setSheet(sheet));
  setSheet('half');
})();
map.on('dragstart', () => mobile() && setSheet('peek'));

loadCells({ fit: true }).catch(() => {});
loadLeaders();
locate();

// ?demo=<photo-url>: scripted walkthrough for recording (see demo.js)
const demo = new URLSearchParams(location.search);
if (demo.has('demo')) {
  import('/demo.js').then((m) => m.run({
    mode: demo.get('demo'), photoUrl: demo.get('photo'), query: demo.get('q'), spot: Number(demo.get('spot') ?? 0),
    submit, where: AT ?? { lat: 40.7794, lng: -73.9632 },
    ensureName: async (name) => {
      if (walker.name) return;
      const res = await fetch('/api/walkers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: walker.id, name }) });
      if (res.ok) { walker.name = (await res.json()).name; saveWalker(); }
    },
  }));
}
