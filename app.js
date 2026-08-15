/* Route Studio — stitch rides into one continuous journey, in the browser.
 *
 * Everything runs client-side. Rides, transfers and settings live in IndexedDB
 * on this machine; nothing is uploaded anywhere. Ride with GPS calls go
 * straight from this page to ridewithgps.com (their API sends
 * Access-Control-Allow-Origin: *), so no server sits in the middle.
 */
'use strict';

// ── Transfer modes ──────────────────────────────────────────────────────────
const MODES = {
  ferry: { color: '#4FC3F7', dash: '1,9',  label: 'Ferry / boat' },
  train: { color: '#FFD166', dash: '14,7', label: 'Train' },
  bus:   { color: '#8BC34A', dash: '7,7',  label: 'Bus / coach' },
  plane: { color: '#EF9A9A', dash: '2,12', label: 'Flight' },
  other: { color: '#B0BEC5', dash: '6,8',  label: 'Other transfer' },
};

const BASEMAPS = {
  dark:    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light:   'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  terrain: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
};
const ATTRIB = '&copy; OpenStreetMap contributors, &copy; CARTO';

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  name: 'My Journey',
  rides: [],        // {id, name, date, points:[[lat,lon],…], dist}
  transfers: [],    // {id, mode, label, points:[[lat,lon],…]}
  settings: { basemap: 'dark', brand: '#FF6B35', simplify: 10, tol: 25 },
  runs: [],
};

let map, tileLayer;
let rideLayer, transferLayer, markerLayer, animLayer;
let drawHandler = null, drawMode = 'ferry';
const anim = { raf: null, playing: false, t: 0, dot: null, trail: null, path: [], cum: [], total: 0 };

// ── Small helpers ───────────────────────────────────────────────────────────
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtKm = (km) => km >= 100 ? Math.round(km).toLocaleString()
                    : km >= 10  ? km.toFixed(1) : km.toFixed(2);

let toastTimer;
function toast(msg, bad) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3500);
}
function status(msg) { $('#status').textContent = msg || ''; }

// ── Geometry ────────────────────────────────────────────────────────────────
function haversineKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function pathKm(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineKm(pts[i - 1], pts[i]);
  return d;
}

/** Ramer–Douglas–Peucker. Iterative: a 20k-point ride would blow the stack.
 *  Guarantees no dropped point sits further than epsM from the kept line. */
function simplify(pts, epsM) {
  if (!(epsM > 0) || pts.length < 3) return pts;
  const ky = 111320, kx = ky * Math.cos(pts[pts.length >> 1][0] * Math.PI / 180);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j <= i + 1) continue;
    const x1 = pts[i][1] * kx, y1 = pts[i][0] * ky;
    const x2 = pts[j][1] * kx, y2 = pts[j][0] * ky;
    const dx = x2 - x1, dy = y2 - y1;
    const den = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const xk = pts[k][1] * kx, yk = pts[k][0] * ky;
      const d = Math.abs(dy * xk - dx * yk + x2 * y1 - y2 * x1) / den;
      if (d > best) { best = d; bi = k; }
    }
    if (best > epsM) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ── GPX ─────────────────────────────────────────────────────────────────────
/** Parse GPX text into {name, date, points}. Returns null if there's no line. */
function parseGPX(text, fallbackName, fallbackDate) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid XML');

  const points = [];
  let when = null;
  for (const pt of doc.querySelectorAll('trkpt')) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    points.push([lat, lon]);
    if (!when) {
      const t = pt.querySelector('time');
      if (t && t.textContent) {
        const d = new Date(t.textContent.trim());
        if (!isNaN(d)) when = d;
      }
    }
  }
  // Routes are a fair fallback for files with no recorded track.
  if (!points.length) {
    for (const pt of doc.querySelectorAll('rtept')) {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      if (isFinite(lat) && isFinite(lon)) points.push([lat, lon]);
    }
  }
  if (points.length < 2) return null;

  const nameEl = doc.querySelector('trk > name') || doc.querySelector('gpx > metadata > name');
  return {
    id: uid(),
    name: (nameEl && nameEl.textContent.trim()) || fallbackName,
    date: (when || fallbackDate || new Date()).toISOString(),
    points,
    dist: pathKm(points),
    noTime: !when,
  };
}

async function addGPXFiles(files) {
  const list = Array.from(files).filter(f => /\.gpx$/i.test(f.name));
  if (!list.length) { toast('No .gpx files in that drop', true); return; }

  let added = 0, failed = 0, undated = 0;
  for (const f of list) {
    status(`Reading ${f.name}…`);
    try {
      const ride = parseGPX(await f.text(), f.name.replace(/\.gpx$/i, ''),
                            new Date(f.lastModified));
      if (!ride) { failed++; continue; }
      if (ride.noTime) undated++;
      state.rides.push(ride);
      added++;
    } catch (e) { failed++; }
  }
  sortRides();
  status('');

  let msg = `Added ${added} ride${added === 1 ? '' : 's'}`;
  if (undated) msg += ` — ${undated} had no timestamps, so the file date was used`;
  if (failed)  msg += `; ${failed} could not be read`;
  toast(msg, failed > 0 && added === 0);

  refreshAll();
  await persist();
}

function sortRides() { state.rides.sort((a, b) => a.date.localeCompare(b.date)); }

// ── Ride with GPS ───────────────────────────────────────────────────────────
function rwHeaders() {
  return {
    'x-rwgps-api-key': $('#rw-key').value.trim(),
    'x-rwgps-auth-token': $('#rw-token').value.trim(),
  };
}

async function rwFetch(path, params) {
  const url = new URL('https://ridewithgps.com' + path);
  url.searchParams.set('version', '2');
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: rwHeaders() });
  if (res.status === 401) throw new Error('Ride with GPS rejected those keys (401)');
  if (!res.ok) throw new Error(`Ride with GPS returned HTTP ${res.status}`);
  return res.json();
}

async function rwSync() {
  const key = $('#rw-key').value.trim(), tok = $('#rw-token').value.trim();
  if (!key || !tok) { toast('Enter both an API key and an auth token', true); return; }

  const prog = $('#rw-progress');
  const btn = $('#btn-rw-sync');
  btn.disabled = true;
  try {
    prog.textContent = 'Looking up your account…';
    let userId = $('#rw-user').value.trim();
    if (!userId) {
      const me = await rwFetch('/api/v1/users/current.json');
      userId = (me.user && me.user.id) || (me.id);
      if (userId) $('#rw-user').value = userId;
    }
    if (!userId) throw new Error('Could not determine your user ID — enter it manually');

    prog.textContent = 'Listing rides…';
    const trips = [];
    for (let offset = 0; ; offset += 100) {
      const page = await rwFetch(`/users/${userId}/trips.json`, { offset, limit: 100 });
      const batch = page.results || [];
      for (const b of batch) trips.push(b);
      if (batch.length < 100) break;
    }

    // Filter by date *before* fetching tracks — each ride is its own request,
    // so a narrow window turns hundreds of calls into a handful.
    const from = $('#rw-from').value, to = $('#rw-to').value;
    const fromMs = from ? Date.parse(from + 'T00:00:00Z') : -Infinity;
    // "up to" is inclusive of the whole day, so run to the end of it.
    const toMs = to ? Date.parse(to + 'T00:00:00Z') + 86400000 - 1 : Infinity;
    if (from && to && fromMs > toMs) {
      throw new Error('The "from" date is after the "up to" date');
    }

    const known = new Set(state.rides.map(r => r.srcId).filter(Boolean));
    const dated = trips.filter(t => t.departed_at);
    const inRange = dated.filter(t => {
      const ms = Date.parse(t.departed_at);
      return ms >= fromMs && ms <= toMs;
    });
    const todo = inRange.filter(t => !known.has('rw' + t.id));

    // Not named `window` — that shadows the global inside this function.
    const rangeText = (from || to)
      ? ` between ${from || 'the start'} and ${to || 'now'}` : '';
    if (!inRange.length) {
      throw new Error(`No rides found${rangeText} — ${dated.length} exist on the account`);
    }
    const outOfRange = dated.length - inRange.length;
    let n = 0;

    for (const t of todo) {
      n++;
      prog.textContent = `Fetching ride ${n} of ${todo.length}…`;
      const data = await rwFetch(`/trips/${t.id}.json`);
      const raw = (data.trip && data.trip.track_points) || [];
      const points = raw.filter(p => p.y != null && p.x != null).map(p => [p.y, p.x]);
      if (points.length < 2) continue;
      state.rides.push({
        id: uid(), srcId: 'rw' + t.id,
        name: t.name || `Ride ${t.id}`,
        date: new Date(t.departed_at).toISOString(),
        points, dist: pathKm(points),
      });
    }

    sortRides();
    localStorage.setItem('rw', JSON.stringify({ key, tok, user: userId, from, to }));
    prog.textContent = '';
    let msg = todo.length
      ? `Added ${todo.length} ride${todo.length === 1 ? '' : 's'} from Ride with GPS`
      : `Already up to date — no new rides${rangeText}`;
    if (outOfRange) msg += `; ${outOfRange} outside the date range were skipped`;
    toast(msg);
    refreshAll();
    await persist();
  } catch (e) {
    prog.textContent = '';
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Joining ─────────────────────────────────────────────────────────────────
/** Concatenate rides in date order, splicing in transfers that bridge the gaps.
 *  A gap with no matching transfer ends the run rather than being closed with a
 *  straight line — months between two tours must never become drawn track. */
function joinJourney(rides, transfers, tolKm) {
  const usable = rides.filter(r => r.points.length > 1);
  if (!usable.length) return [];

  const pool = transfers.map(t => ({ ...t, used: false }));
  const runs = [];
  let current = usable[0].points.slice();
  let bridges = [];

  for (let i = 1; i < usable.length; i++) {
    const ride = usable[i];
    const end = current[current.length - 1], start = ride.points[0];
    if (haversineKm(end, start) <= tolKm) {
      current = current.concat(ride.points);
      continue;
    }

    let bridge = null;
    for (const c of pool) {
      if (c.used) continue;
      const p = c.points, a = p[0], b = p[p.length - 1];
      if (haversineKm(end, a) <= tolKm && haversineKm(b, start) <= tolKm) bridge = p;
      else if (haversineKm(end, b) <= tolKm && haversineKm(a, start) <= tolKm) bridge = p.slice().reverse();
      if (bridge) { c.used = true; bridges.push(c); break; }
    }

    if (bridge) {
      current = current.concat(bridge, ride.points);
    } else {
      runs.push({ points: current, bridges });
      current = ride.points.slice();
      bridges = [];
    }
  }
  runs.push({ points: current, bridges });
  runs.forEach(r => { r.km = pathKm(r.points); });
  return runs;
}

function recomputeRuns() {
  state.runs = joinJourney(state.rides, state.transfers, state.settings.tol);
  const unmatched = state.transfers.length -
    state.runs.reduce((n, r) => n + r.bridges.length, 0);
  const totalKm = state.runs.reduce((s, r) => s + r.km, 0);

  const el = $('#join-report');
  if (!state.rides.length) { el.innerHTML = ''; return; }
  let html = `<b>${state.runs.length}</b> continuous run${state.runs.length === 1 ? '' : 's'}` +
             ` &middot; <b>${fmtKm(totalKm)} km</b>`;
  if (state.runs.length > 1) {
    html += `<br>Draw a transfer across each remaining gap to merge them into one line.`;
  }
  if (unmatched > 0) {
    html += `<br><span class="warn">${unmatched} transfer${unmatched === 1 ? '' : 's'} ` +
            `did not match a gap — the ends are more than ${state.settings.tol} km ` +
            `from any ride. Extend the line or raise the join tolerance.</span>`;
  }
  el.innerHTML = html;
}

// ── Map ─────────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([46, 6], 5);
  setBasemap(state.settings.basemap);
  rideLayer = L.layerGroup().addTo(map);
  transferLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  animLayer = L.layerGroup().addTo(map);
}

function setBasemap(kind) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(BASEMAPS[kind] || BASEMAPS.dark, {
    attribution: ATTRIB, maxZoom: 18,
  }).addTo(map);
  tileLayer.bringToBack();
}

/** Blue (earliest) → the brand colour (most recent). */
function rideColor(i, total) {
  const hex = state.settings.brand.replace('#', '');
  const br = parseInt(hex.slice(0, 2), 16), bg = parseInt(hex.slice(2, 4), 16), bb = parseInt(hex.slice(4, 6), 16);
  const f = total < 2 ? 1 : i / (total - 1);
  const r = Math.round(64 + (br - 64) * f), g = Math.round(120 + (bg - 120) * f), b = Math.round(200 + (bb - 200) * f);
  return `rgb(${r},${g},${b})`;
}

function drawRides() {
  rideLayer.clearLayers();
  markerLayer.clearLayers();
  const eps = state.settings.simplify;
  state.rides.forEach((ride, i) => {
    const pts = simplify(ride.points, eps);
    L.polyline(pts, {
      color: rideColor(i, state.rides.length), weight: 2.5, opacity: .88,
    }).bindTooltip(`${ride.date.slice(0, 10)} — ${ride.name} (${fmtKm(ride.dist)} km)`)
      .addTo(rideLayer);
  });

  if (state.rides.length) {
    const first = state.rides[0], last = state.rides[state.rides.length - 1];
    L.circleMarker(first.points[0], { radius: 6, color: '#8fbf6f', fillColor: '#8fbf6f', fillOpacity: 1, weight: 2 })
      .bindTooltip(`Start — ${first.date.slice(0, 10)}`).addTo(markerLayer);
    L.circleMarker(last.points[last.points.length - 1], { radius: 6, color: state.settings.brand, fillColor: state.settings.brand, fillOpacity: 1, weight: 2 })
      .bindTooltip(`Latest — ${last.date.slice(0, 10)}`).addTo(markerLayer);
  }
}

function drawTransfers() {
  transferLayer.clearLayers();
  state.transfers.forEach(t => {
    const st = MODES[t.mode] || MODES.other;
    L.polyline(t.points, { color: st.color, weight: 3, opacity: .95, dashArray: st.dash })
      .bindTooltip(t.label || st.label)
      .addTo(transferLayer);
  });
}

function fitAll() {
  const all = [];
  state.rides.forEach(r => all.push(r.points[0], r.points[r.points.length - 1]));
  state.transfers.forEach(t => { for (const p of t.points) all.push(p); });
  if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.08));
}

// ── Drawing transfers ───────────────────────────────────────────────────────
function buildModePicker() {
  const box = $('#mode-picker');
  box.innerHTML = '';
  for (const [key, st] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.className = 'mode-btn' + (key === drawMode ? ' active' : '');
    b.dataset.mode = key;
    b.innerHTML = `<span class="dash" style="background:${st.color}"></span><span>${st.label}</span>`;
    b.onclick = () => {
      drawMode = key;
      $$('.mode-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === key));
    };
    box.appendChild(b);
  }
}

function startDrawing() {
  if (drawHandler) { drawHandler.disable(); drawHandler = null; }
  const st = MODES[drawMode];
  drawHandler = new L.Draw.Polyline(map, {
    shapeOptions: { color: st.color, weight: 3, dashArray: st.dash },
  });
  drawHandler.enable();
  $('#draw-hint').hidden = false;
  $('#btn-draw').textContent = 'Drawing… (Esc to cancel)';
}

function stopDrawing() {
  if (drawHandler) { drawHandler.disable(); drawHandler = null; }
  $('#draw-hint').hidden = true;
  $('#btn-draw').textContent = 'Start drawing';
}

function onDrawCreated(e) {
  const pts = e.layer.getLatLngs().map(ll => [ll.lat, ll.lng]);
  if (pts.length < 2) { stopDrawing(); return; }
  const typed = $('#transfer-label').value.trim();
  state.transfers.push({
    id: uid(), mode: drawMode,
    label: typed || MODES[drawMode].label,
    points: pts,
  });
  $('#transfer-label').value = '';
  stopDrawing();
  toast(`Added ${MODES[drawMode].label.toLowerCase()} (${fmtKm(pathKm(pts))} km)`);
  refreshAll();
  persist();
}

// ── Animation ───────────────────────────────────────────────────────────────
// The animated line is redrawn every frame, so its point count sets the frame
// cost. Beyond a few thousand there is nothing more to see — the extra vertices
// land inside the same pixel — so the path gets its own, coarser budget than the
// static map. This is what keeps a 200k-point journey at 60fps.
const MAX_ANIM_POINTS = 6000;

function prepareAnim() {
  // One sequence across every run, in travel order, remembering where each new
  // run starts. Those boundaries are gaps with no transfer drawn — the dot must
  // jump them, not glide across, or the animation implies travel that never
  // happened (the same reason the map never draws a line there).
  const build = (eps) => {
    const pts = [];
    const breaks = new Set();
    state.runs.forEach(r => {
      if (pts.length) breaks.add(pts.length);
      // A loop, not push(...spread): spreading ~50k elements overflows the
      // stack, and a real season's journey is comfortably past that.
      const simp = simplify(r.points, eps);
      for (let i = 0; i < simp.length; i++) pts.push(simp[i]);
    });
    return { pts, breaks };
  };

  let eps = Math.max(state.settings.simplify, 5);
  let out = build(eps);
  // Coarsen until the path fits the budget. Doubling converges in a few passes.
  while (out.pts.length > MAX_ANIM_POINTS && eps < 20000) {
    eps *= 2;
    out = build(eps);
  }

  anim.path = out.pts;
  anim.breaks = out.breaks;
  // The reusable layers belong to the old path — drop them.
  animLayer.clearLayers();
  anim.dot = null;
  anim.trails = [];

  const pts = anim.path, breaks = anim.breaks;
  anim.cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    if (!breaks.has(i)) total += haversineKm(pts[i - 1], pts[i]);
    anim.cum.push(total);           // zero-length step: the dot teleports
  }
  anim.total = total;
  $('#scrubber').hidden = pts.length < 2;
}

/** Position at fraction f (0–1) along the path, interpolated between points. */
function atFraction(f) {
  if (anim.path.length < 2) return null;
  const target = f * anim.total;
  let lo = 0, hi = anim.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (anim.cum[mid] < target) lo = mid + 1; else hi = mid; }
  const i = Math.max(1, lo);
  const seg = anim.cum[i] - anim.cum[i - 1] || 1e-9;
  const r = Math.min(1, Math.max(0, (target - anim.cum[i - 1]) / seg));
  const a = anim.path[i - 1], b = anim.path[i];
  return { pos: [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r], idx: i };
}

function renderAnim() {
  const at = atFraction(anim.t);
  if (!at) return;

  // Layers are created once and updated in place. Rebuilding them every frame meant
  // allocating and re-projecting the whole line sixty times a second.
  if (!anim.dot) {
    anim.dot = L.circleMarker(at.pos, {
      radius: 7, color: '#fff', weight: 2,
      fillColor: state.settings.brand, fillOpacity: 1,
    }).addTo(animLayer);
    anim.trails = [];
  }

  if ($('#trail').value === 'draw') {
    // Break the trail at run boundaries so it never spans an undrawn gap.
    const head = anim.path.slice(0, at.idx);
    head.push(at.pos);
    const segs = [];
    let seg = [];
    for (let i = 0; i < head.length; i++) {
      if (anim.breaks.has(i) && seg.length > 1) { segs.push(seg); seg = []; }
      seg.push(head[i]);
    }
    if (seg.length > 1) segs.push(seg);

    segs.forEach((s, i) => {
      if (!anim.trails[i]) {
        anim.trails[i] = L.polyline(s, {
          color: state.settings.brand, weight: 4, opacity: .95,
        }).addTo(animLayer);
      } else {
        anim.trails[i].setLatLngs(s);
        anim.trails[i].setStyle({ color: state.settings.brand });
      }
    });
    for (let i = segs.length; i < anim.trails.length; i++) anim.trails[i].setLatLngs([]);
  } else if (anim.trails) {
    anim.trails.forEach(t => t.setLatLngs([]));
  }

  anim.dot.setLatLng(at.pos);
  anim.dot.setStyle({ fillColor: state.settings.brand });

  if ($('#follow').checked) map.panTo(at.pos, { animate: false });

  const done = anim.t * anim.total;
  $('#progress').value = Math.round(anim.t * 1000);
  $('#progress-label').textContent = `${fmtKm(done)} / ${fmtKm(anim.total)} km`;
  $('#anim-readout').innerHTML =
    `<b>${fmtKm(done)} km</b> of ${fmtKm(anim.total)} km &middot; ` +
    `${Math.round(anim.t * 100)}%<br>${anim.path.length.toLocaleString()} points in the path`;
}

function tick(ts) {
  if (!anim.playing) return;
  if (!tick.last) tick.last = ts;
  const dt = (ts - tick.last) / 1000;
  tick.last = ts;

  const speed = parseFloat($('#speed').value);
  // 40 seconds for the whole journey at 1×, whatever its length.
  anim.t += (dt / 40) * speed;
  if (anim.t >= 1) { anim.t = 1; setPlaying(false); }
  renderAnim();
  if (anim.playing) anim.raf = requestAnimationFrame(tick);
}

function setPlaying(on) {
  anim.playing = on;
  tick.last = 0;
  $('#btn-play').textContent = on ? '❚❚ Pause' : '▶ Play';
  $('#btn-play-2').textContent = on ? '❚❚' : '▶';
  if (on) {
    if (anim.t >= 1) anim.t = 0;
    anim.raf = requestAnimationFrame(tick);
  } else if (anim.raf) {
    cancelAnimationFrame(anim.raf);
  }
}

// ── Panels ──────────────────────────────────────────────────────────────────
function renderRides() {
  const ul = $('#rides-list');
  ul.innerHTML = '';
  state.rides.forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="sw" style="background:${rideColor(i, state.rides.length)}"></span>` +
      `<span class="nm" title="${escapeHTML(r.name)}">${escapeHTML(r.name)}</span>` +
      `<span class="meta">${r.date.slice(0, 10)} · ${fmtKm(r.dist)} km</span>` +
      `<button class="del" title="Remove">✕</button>`;
    li.querySelector('.del').onclick = () => {
      state.rides.splice(i, 1); refreshAll(); persist();
    };
    li.onmouseenter = () => highlight(r.points);
    li.onmouseleave = () => clearHighlight();
    ul.appendChild(li);
  });
  const km = state.rides.reduce((s, r) => s + r.dist, 0);
  $('#rides-count').textContent = state.rides.length
    ? `${state.rides.length} rides · ${fmtKm(km)} km` : 'No rides yet';
}

function renderTransfers() {
  const ul = $('#transfers-list');
  ul.innerHTML = '';
  state.transfers.forEach((t, i) => {
    const st = MODES[t.mode] || MODES.other;
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="sw" style="background:${st.color}"></span>` +
      `<span class="nm" title="${escapeHTML(t.label)}">${escapeHTML(t.label)}</span>` +
      `<span class="meta">${fmtKm(pathKm(t.points))} km</span>` +
      `<button class="del" title="Remove">✕</button>`;
    li.querySelector('.del').onclick = () => {
      state.transfers.splice(i, 1); refreshAll(); persist();
    };
    li.onmouseenter = () => highlight(t.points);
    li.onmouseleave = () => clearHighlight();
    ul.appendChild(li);
  });
  $('#transfers-count').textContent = state.transfers.length
    ? `${state.transfers.length} transfer${state.transfers.length === 1 ? '' : 's'}`
    : 'No transfers yet';
}

let hl = null;
function highlight(pts) {
  clearHighlight();
  hl = L.polyline(pts, { color: '#fff', weight: 6, opacity: .5 }).addTo(map);
}
function clearHighlight() { if (hl) { map.removeLayer(hl); hl = null; } }

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function refreshAll() {
  drawRides();
  drawTransfers();
  recomputeRuns();
  renderRides();
  renderTransfers();
  prepareAnim();
  renderAnim();
}

// ── Storage (IndexedDB) ─────────────────────────────────────────────────────
// localStorage would not do: 200k track points blow past its ~5 MB quota.
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('route-studio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('projects');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persist() {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(serialise(), 'current');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    status('Saved');
    setTimeout(() => status(''), 1200);
  } catch (e) {
    toast('Could not save to this browser: ' + e.message, true);
  }
}

async function restore() {
  try {
    const db = await idb();
    const data = await new Promise((res, rej) => {
      const tx = db.transaction('projects', 'readonly');
      const r = tx.objectStore('projects').get('current');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    if (data) load(data);
  } catch (e) { /* first run, or storage blocked — start empty */ }

  try {
    const rw = JSON.parse(localStorage.getItem('rw') || 'null');
    if (rw) {
      $('#rw-key').value = rw.key; $('#rw-token').value = rw.tok;
      $('#rw-user').value = rw.user || '';
      $('#rw-from').value = rw.from || ''; $('#rw-to').value = rw.to || '';
    }
  } catch (e) {}
}

function serialise() {
  return {
    v: 1, name: state.name, rides: state.rides,
    transfers: state.transfers, settings: state.settings,
  };
}

function load(data) {
  state.name = data.name || 'My Journey';
  state.rides = data.rides || [];
  state.transfers = data.transfers || [];
  Object.assign(state.settings, data.settings || {});
  $('#project-name').value = state.name;
  $('#basemap').value = state.settings.basemap;
  $('#brand').value = state.settings.brand;
  $('#simplify').value = state.settings.simplify;
  $('#simplify-val').textContent = state.settings.simplify;
  $('#tol').value = state.settings.tol;
  $('#tol-val').textContent = state.settings.tol;
  setBasemap(state.settings.settings || state.settings.basemap);
  refreshAll();
  if (state.rides.length) fitAll();
}

// ── Export ──────────────────────────────────────────────────────────────────
function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function runsGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: state.runs.map((r, i) => ({
      type: 'Feature',
      properties: {
        run: i + 1, points: r.points.length, distance_km: +r.km.toFixed(1),
        bridged_by: r.bridges.map(b => `${b.mode}: ${b.label}`),
      },
      geometry: {
        type: 'LineString',
        coordinates: r.points.map(([lat, lon]) => [+lon.toFixed(5), +lat.toFixed(5)]),
      },
    })),
  };
}

function runsGPX() {
  const esc = escapeHTML;
  const segs = state.runs.map(r =>
    '  <trkseg>\n' +
    r.points.map(([la, lo]) => `   <trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>`).join('\n') +
    '\n  </trkseg>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Route Studio" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><name>${esc(state.name)}</name></metadata>
 <trk><name>${esc(state.name)}</name>
${segs}
 </trk>
</gpx>`;
}

/** A single self-contained page: the map, the transfers, and the animation. */
function shareableHTML() {
  const eps = Math.max(state.settings.simplify, 8);
  const payload = {
    name: state.name,
    brand: state.settings.brand,
    basemap: state.settings.basemap,
    rides: state.rides.map((r, i) => ({
      n: r.name, d: r.date.slice(0, 10), km: +r.dist.toFixed(1),
      c: rideColor(i, state.rides.length),
      p: simplify(r.points, eps).map(([a, o]) => [+a.toFixed(5), +o.toFixed(5)]),
    })),
    transfers: state.transfers.map(t => ({
      m: t.mode, l: t.label,
      p: t.points.map(([a, o]) => [+a.toFixed(5), +o.toFixed(5)]),
    })),
    runs: state.runs.map(r => simplify(r.points, eps).map(([a, o]) => [+a.toFixed(5), +o.toFixed(5)])),
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(state.name)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
 html,body{height:100%;margin:0;background:#0d0d0a;color:#f0ebe3;
   font:14px/1.5 system-ui,sans-serif}
 #map{position:absolute;inset:0}
 #title{position:absolute;top:14px;left:56px;z-index:900;background:rgba(12,12,9,.82);
   border-left:4px solid ${state.settings.brand};border-radius:8px;padding:9px 15px;
   box-shadow:0 2px 12px rgba(0,0,0,.5)}
 #title h1{margin:0;font-size:17px;letter-spacing:.03em}
 #title small{color:#a19a8f}
 #bar{position:absolute;left:50%;transform:translateX(-50%);bottom:16px;z-index:900;
   display:flex;gap:11px;align-items:center;background:rgba(12,12,9,.9);
   border:1px solid #34342e;border-radius:24px;padding:8px 15px;
   width:min(600px,calc(100% - 36px))}
 #bar input{flex:1;accent-color:${state.settings.brand}}
 #bar button{width:32px;height:32px;border-radius:50%;border:0;
   background:${state.settings.brand};color:#1a1206;cursor:pointer}
 #lbl{color:#a19a8f;font-size:12px;min-width:104px;text-align:right;
   font-family:ui-monospace,Menlo,monospace}
 #legend{position:absolute;right:12px;bottom:70px;z-index:900;
   background:rgba(12,12,9,.82);border-radius:8px;padding:9px 12px;font-size:11px}
 #legend div{display:flex;align-items:center;gap:8px;margin:3px 0}
 #legend i{width:26px;height:0;border-top:3px dashed;display:block}
</style></head><body>
<div id="map"></div>
<div id="title"><h1>${escapeHTML(state.name)}</h1><small id="sub"></small></div>
<div id="legend"></div>
<div id="bar"><button id="pp">▶</button><input id="pr" type="range" min="0" max="1000" value="0"><span id="lbl"></span></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script>
const D=${JSON.stringify(payload)};
const MODES=${JSON.stringify(MODES)};
const TILES=${JSON.stringify(BASEMAPS)};
const map=L.map('map',{preferCanvas:true}).setView([46,6],5);
L.tileLayer(TILES[D.basemap]||TILES.dark,{attribution:'${ATTRIB}',maxZoom:18}).addTo(map);
const all=[];
D.rides.forEach(r=>{L.polyline(r.p,{color:r.c,weight:2.5,opacity:.88})
  .bindTooltip(r.d+' — '+r.n+' ('+r.km+' km)').addTo(map);all.push(r.p[0],r.p[r.p.length-1]);});
const used={};
D.transfers.forEach(t=>{const s=MODES[t.m]||MODES.other;used[t.m]=1;
  L.polyline(t.p,{color:s.color,weight:3,opacity:.95,dashArray:s.dash})
   .bindTooltip(t.l).addTo(map);t.p.forEach(p=>all.push(p));});
if(all.length)map.fitBounds(L.latLngBounds(all).pad(.08));
const lg=document.getElementById('legend');
Object.keys(used).forEach(m=>{const s=MODES[m];
  lg.insertAdjacentHTML('beforeend','<div><i style="border-color:'+s.color+'"></i>'+s.label+'</div>');});
if(!Object.keys(used).length)lg.style.display='none';

const path=[],brk=new Set();
D.runs.forEach(r=>{if(path.length)brk.add(path.length);r.forEach(p=>path.push(p));});
const cum=[0];let tot=0;
function hav(a,b){const R=6371,r=Math.PI/180,dla=(b[0]-a[0])*r,dlo=(b[1]-a[1])*r;
 const s=Math.sin(dla/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dlo/2)**2;
 return 2*R*Math.asin(Math.sqrt(s));}
/* zero-length across run boundaries: the dot jumps an undrawn gap */
for(let i=1;i<path.length;i++){if(!brk.has(i))tot+=hav(path[i-1],path[i]);cum.push(tot);}
document.getElementById('sub').textContent=
  D.rides.length+' rides · '+Math.round(tot).toLocaleString()+' km';
let t=0,playing=false,raf,last=0,dot,head;
function at(f){const g=f*tot;let lo=0,hi=cum.length-1;
 while(lo<hi){const m=(lo+hi)>>1;if(cum[m]<g)lo=m+1;else hi=m;}
 const i=Math.max(1,lo),seg=cum[i]-cum[i-1]||1e-9;
 const r=Math.min(1,Math.max(0,(g-cum[i-1])/seg)),a=path[i-1],b=path[i];
 return{pos:[a[0]+(b[0]-a[0])*r,a[1]+(b[1]-a[1])*r],idx:i};}
function render(){if(path.length<2)return;const p=at(t);
 if(head)head.forEach(h=>map.removeLayer(h));if(dot)map.removeLayer(dot);
 const pts=path.slice(0,p.idx).concat([p.pos]);head=[];let seg=[];
 for(let i=0;i<pts.length;i++){if(brk.has(i)&&seg.length>1){
   head.push(L.polyline(seg,{color:'${state.settings.brand}',weight:4,opacity:.95}).addTo(map));seg=[];}
  seg.push(pts[i]);}
 if(seg.length>1)head.push(L.polyline(seg,{color:'${state.settings.brand}',weight:4,opacity:.95}).addTo(map));
 dot=L.circleMarker(p.pos,{radius:7,color:'#fff',weight:2,
   fillColor:'${state.settings.brand}',fillOpacity:1}).addTo(map);
 document.getElementById('pr').value=Math.round(t*1000);
 document.getElementById('lbl').textContent=Math.round(t*tot).toLocaleString()+' / '+Math.round(tot).toLocaleString()+' km';}
function step(ts){if(!playing)return;if(!last)last=ts;
 t+=((ts-last)/1000)/40;last=ts;if(t>=1){t=1;play(false);}render();
 if(playing)raf=requestAnimationFrame(step);}
function play(on){playing=on;last=0;document.getElementById('pp').textContent=on?'❚❚':'▶';
 if(on){if(t>=1)t=0;raf=requestAnimationFrame(step);}else if(raf)cancelAnimationFrame(raf);}
document.getElementById('pp').onclick=()=>play(!playing);
document.getElementById('pr').oninput=e=>{play(false);t=e.target.value/1000;render();};
render();
<\/script></body></html>`;
}

function doExport(kind) {
  const safe = state.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'journey';
  if (!state.rides.length && kind !== 'project') { toast('Add some rides first', true); return; }
  if (kind === 'geojson') download(safe + '-route.geojson', JSON.stringify(runsGeoJSON()), 'application/geo+json');
  if (kind === 'gpx')     download(safe + '-route.gpx', runsGPX(), 'application/gpx+xml');
  if (kind === 'project') download(safe + '-project.json', JSON.stringify(serialise()), 'application/json');
  if (kind === 'html') {
    download(safe + '-map.html', shareableHTML(), 'text/html');
    toast('Saved. Upload that file anywhere — GitHub Pages, Netlify — to share it.');
    return;
  }
  toast('Exported ' + kind);
}

// ── Wiring ──────────────────────────────────────────────────────────────────
function wire() {
  // Tabs
  $$('.tab').forEach(t => t.onclick = () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.tab-body').forEach(b => b.classList.toggle('active', b.dataset.body === t.dataset.tab));
    if (t.dataset.tab !== 'transfers') stopDrawing();
  });

  // Files
  $('#btn-pick').onclick = () => $('#file-input').click();
  $('#file-input').onchange = e => { addGPXFiles(e.target.files); e.target.value = ''; };
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.classList.add('hot');
  }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.classList.remove('hot');
  }));
  dz.addEventListener('drop', e => addGPXFiles(e.dataTransfer.files));
  // Dropping anywhere on the window works too, but don't hijack the browser.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addGPXFiles(e.dataTransfer.files);
  });

  $('#btn-clear-rides').onclick = () => {
    if (!state.rides.length) return;
    if (!confirm(`Remove all ${state.rides.length} rides? Transfers are kept.`)) return;
    state.rides = []; refreshAll(); persist();
  };
  $('#btn-clear-transfers').onclick = () => {
    if (!state.transfers.length) return;
    if (!confirm(`Remove all ${state.transfers.length} transfers?`)) return;
    state.transfers = []; refreshAll(); persist();
  };

  // Ride with GPS
  $('#btn-rw-sync').onclick = rwSync;
  $('#btn-rw-forget').onclick = () => {
    localStorage.removeItem('rw');
    $('#rw-key').value = $('#rw-token').value = $('#rw-user').value = '';
    $('#rw-from').value = $('#rw-to').value = '';
    toast('Keys removed from this browser');
  };

  // Transfers
  buildModePicker();
  $('#btn-draw').onclick = () => drawHandler ? stopDrawing() : startDrawing();
  map.on(L.Draw.Event.CREATED, onDrawCreated);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') stopDrawing(); });

  // Animation
  $('#btn-play').onclick = () => setPlaying(!anim.playing);
  $('#btn-play-2').onclick = () => setPlaying(!anim.playing);
  $('#btn-restart').onclick = () => { anim.t = 0; renderAnim(); };
  $('#speed').oninput = e => $('#speed-val').textContent = (+e.target.value) + '×';
  $('#trail').onchange = renderAnim;
  $('#progress').oninput = e => { setPlaying(false); anim.t = e.target.value / 1000; renderAnim(); };

  // Settings
  $('#basemap').onchange = e => { state.settings.basemap = e.target.value; setBasemap(e.target.value); persist(); };
  $('#brand').oninput = e => { state.settings.brand = e.target.value; refreshAll(); };
  $('#brand').onchange = persist;
  $('#simplify').oninput = e => {
    state.settings.simplify = +e.target.value;
    $('#simplify-val').textContent = e.target.value;
    drawRides(); prepareAnim(); renderAnim();
  };
  $('#simplify').onchange = persist;
  $('#tol').oninput = e => {
    state.settings.tol = +e.target.value;
    $('#tol-val').textContent = e.target.value;
    recomputeRuns(); prepareAnim(); renderAnim();
  };
  $('#tol').onchange = persist;

  $('#project-name').oninput = e => { state.name = e.target.value; };
  $('#project-name').onchange = persist;
  $('#btn-save').onclick = persist;

  $('#btn-import').onclick = () => $('#import-input').click();
  $('#import-input').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      load(JSON.parse(await f.text()));
      await persist();
      toast('Project loaded');
    } catch (err) { toast('That is not a Route Studio project file', true); }
  };

  $('#btn-reset').onclick = async () => {
    if (!confirm('Delete every ride, transfer and setting from this browser?')) return;
    state.rides = []; state.transfers = []; state.name = 'My Journey';
    $('#project-name').value = state.name;
    refreshAll(); await persist();
    toast('Cleared');
  };

  // Export menu
  const menu = $('#export-menu');
  $('#btn-export').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', e => {
    const k = e.target.dataset.export;
    if (k) { menu.hidden = true; doExport(k); }
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────
(async function boot() {
  initMap();
  wire();
  await restore();
  refreshAll();
  if (state.rides.length) fitAll();
})();
