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

// Basemap. Keyless, no account, no quota — VersaTiles serves OpenStreetMap
// vector tiles (open source, versatiles.org), rendered by MapLibre GL inside
// Leaflet via maplibre-gl-leaflet so overlays, drawing and the animation are
// unaffected.
//
// NOTE: this style ships `projection: {type: "globe"}`. Leaflet draws its
// overlays in Web Mercator, so a globe basemap slides out from under the
// route lines. forceMercator() below strips that before the style is handed
// to MapLibre — without it the track does not sit on the map.
const OSM_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const BASEMAPS = {
  muted: {
    label: 'Muted', type: 'vector',
    style: 'https://tiles.versatiles.org/assets/styles/muted/style.json',
    attribution: OSM_ATTRIB + ', tiles by <a href="https://versatiles.org">VersaTiles</a>',
  },
};

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  name: 'My Journey',
  rides: [],        // {id, name, date, points:[[lat,lon],…], dist}
  transfers: [],    // {id, mode, label, points:[[lat,lon],…]}
  settings: { basemap: 'muted', brand: '#FF6B35', simplify: 10, tol: 25 },
  runs: [],
};

let map, tileLayer;
let haloLayer, rideLayer, transferLayer, markerLayer, animLayer;
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

/** Total climbing, in metres.
 *
 *  Both barometric and GPS elevation jitter by a metre or two even at a
 *  standstill. A bare threshold does not help: an oscillation wider than the
 *  threshold still accumulates on every swing, which turns a cafe stop into
 *  hundreds of metres of phantom climbing. So smooth the series first with a
 *  short moving average, then take positive moves that clear the threshold —
 *  roughly what a bike computer does.
 */
function ascentM(pts, thresholdM = 3, window = 5) {
  const el = [];
  for (const p of pts) {
    const e = p[2];
    if (e != null && isFinite(e)) el.push(Number(e));
  }
  if (el.length < 3) return 0;

  const half = Math.max(1, Math.floor(window / 2));
  let gain = 0, ref = null;
  for (let i = 0; i < el.length; i++) {
    const a = Math.max(0, i - half), b = Math.min(el.length - 1, i + half);
    let sum = 0;
    for (let k = a; k <= b; k++) sum += el[k];
    const e = sum / (b - a + 1);

    if (ref === null) { ref = e; continue; }
    if (e > ref + thresholdM) { gain += e - ref; ref = e; }
    else if (e < ref) { ref = e; }
  }
  return gain;
}

/** Seconds to "4h 12m" / "48m". */
function fmtDuration(sec) {
  if (!sec || !isFinite(sec) || sec <= 0) return null;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
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
  let when = null, lastTime = null;
  for (const pt of doc.querySelectorAll('trkpt')) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) continue;

    // Elevation rides along as a third ordinate. Everything that handles
    // points reads [0] and [1] only, so this is invisible to them, and it
    // keeps projects saved before this change loadable.
    const eleEl = pt.querySelector('ele');
    const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;
    points.push(isFinite(ele) ? [lat, lon, ele] : [lat, lon]);

    const t = pt.querySelector('time');
    if (t && t.textContent) {
      const d = new Date(t.textContent.trim());
      if (!isNaN(d)) { if (!when) when = d; lastTime = d; }
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
  // GPX has no duration field, so this is elapsed time between the first and
  // last stamped point — it includes stops, unlike Ride with GPS's figure.
  const duration = (when && lastTime && lastTime > when)
    ? (lastTime - when) / 1000 : null;
  return {
    id: uid(),
    name: (nameEl && nameEl.textContent.trim()) || fallbackName,
    date: (when || fallbackDate || new Date()).toISOString(),
    points,
    dist: pathKm(points),
    ascent: ascentM(points),
    duration,
    elapsed: true,          // distinguishes it from a moving-time figure
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

    const known = new Map(state.rides.filter(r => r.srcId).map(r => [r.srcId, r]));
    const dated = trips.filter(t => t.departed_at);
    const inRange = dated.filter(t => {
      const ms = Date.parse(t.departed_at);
      return ms >= fromMs && ms <= toMs;
    });

    // Re-fetch a ride we already hold if it has no elevation on it. Rides
    // synced before elevation was captured are stored as plain [lat, lon],
    // and skipping them on the grounds that we "have" them would leave the
    // profile permanently empty with no way to repair it.
    const stale = [];
    const todo = inRange.filter(t => {
      const have = known.get('rw' + t.id);
      if (!have) return true;
      const hasEle = have.points.some(p => p.length > 2 && p[2] != null);
      if (!hasEle) { stale.push('rw' + t.id); return true; }
      return false;
    });

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
      const trip = data.trip || {};
      const raw = trip.track_points || [];
      // Ride with GPS names elevation "e" on each track point; it rides along
      // as a third ordinate, same as the GPX path.
      const points = raw.filter(p => p.y != null && p.x != null).map(p => {
        // Documented as `e`; the others cost nothing and guard against a
        // response shape that differs from the reference.
        const e = [p.e, p.elevation, p.ele].find(v => v != null && isFinite(v));
        return e != null ? [p.y, p.x, Number(e)] : [p.y, p.x];
      });
      if (points.length < 2) continue;

      // Duration comes from the API's own field, as asked. Climbing is
      // always derived from the elevation values on the track itself, the
      // same way a GPX file is read — one number, one source.
      const dur = [trip.duration, t.duration, trip.moving_time]
                    .find(v => v != null && isFinite(v) && v > 0);

      // Replace rather than duplicate when refreshing a stale ride.
      const existingAt = state.rides.findIndex(r => r.srcId === 'rw' + t.id);
      if (existingAt !== -1) state.rides.splice(existingAt, 1);

      state.rides.push({
        id: uid(), srcId: 'rw' + t.id,
        name: t.name || `Ride ${t.id}`,
        date: new Date(t.departed_at).toISOString(),
        points, dist: pathKm(points),
        ascent: ascentM(points),
        duration: dur != null ? Number(dur) : null,
        elapsed: false,        // this is moving time, not wall clock
      });
    }

    sortRides();
    localStorage.setItem('rw', JSON.stringify({ key, tok, user: userId, from, to }));
    prog.textContent = '';
    const added = todo.length - stale.length;
    const parts = [];
    if (added > 0) parts.push(`Added ${added} ride${added === 1 ? '' : 's'}`);
    if (stale.length) parts.push(`refreshed ${stale.length} for elevation`);
    let msg = parts.length ? parts.join(', ')
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

    const bridge = findBridge(end, start, pool, tolKm);
    if (bridge.found) {
      bridge.legs.forEach(idx => { pool[idx].used = true; bridges.push(pool[idx]); });
      current = current.concat(bridge.points, ride.points);
    } else {
      runs.push({
        points: current, bridges,
        breakAfter: {
          gapKm: haversineKm(end, start),
          nearestKm: bridge.bestKm,          // how far short the best chain stopped
          nearestLabel: bridge.bestLabel,
          date: ride.date ? String(ride.date).slice(0, 10) : null,
        },
      });
      current = ride.points.slice();
      bridges = [];
    }
  }
  runs.push({ points: current, bridges });
  runs.forEach(r => { r.km = pathKm(r.points); });
  return runs;
}

/** Find a chain of drawn transfers leading from `end` to `start`.
 *
 * A gap is often covered by more than one leg — two trains with a change in
 * between, or a bus to a port then a ferry. Matching only single transfers
 * left those gaps unbridged even though the user had drawn every piece.
 *
 * Breadth-first over the unused transfers, so the fewest-leg chain wins. Each
 * transfer is undirected: whichever end is reachable becomes its entry point
 * and the line is reversed if needed.
 */
function findBridge(end, start, pool, tolKm, maxLegs = 6, maxVisits = 20000) {
  const queue = [{ pos: end, legs: [], points: [] }];
  let head = 0, visits = 0;
  // Closest any chain got to the next ride. When nothing reaches, this is the
  // number worth showing: "your legs stop N km short", not the distance to a
  // leg that already attaches perfectly at its other end.
  let bestKm = Infinity, bestLabel = null;

  while (head < queue.length) {
    const cur = queue[head++];
    if (++visits > maxVisits) break;      // pathological pools shouldn't hang the UI

    if (cur.legs.length) {
      const d = haversineKm(cur.pos, start);
      if (d <= tolKm) return { found: true, points: cur.points, legs: cur.legs };
      if (d < bestKm) { bestKm = d; bestLabel = pool[cur.legs[cur.legs.length - 1]].label; }
    }
    if (cur.legs.length >= maxLegs) continue;

    for (let i = 0; i < pool.length; i++) {
      if (pool[i].used || cur.legs.indexOf(i) !== -1) continue;
      const p = pool[i].points;
      let seg = null;
      if (haversineKm(cur.pos, p[0]) <= tolKm) seg = p;
      else if (haversineKm(cur.pos, p[p.length - 1]) <= tolKm) seg = p.slice().reverse();
      if (!seg) continue;

      queue.push({
        pos: seg[seg.length - 1],
        legs: cur.legs.concat(i),
        points: cur.points.concat(seg),
      });
    }
  }
  return { found: false, bestKm: isFinite(bestKm) ? bestKm : null, bestLabel };
}

function recomputeRuns() {
  state.runs = joinJourney(state.rides, state.transfers, state.settings.tol);
  const unmatched = state.transfers.length -
    state.runs.reduce((n, r) => n + r.bridges.length, 0);

  const el = $('#join-report');
  if (!state.rides.length) { el.innerHTML = ''; return; }

  const riddenKm = state.rides.reduce((a, r) => a + r.dist, 0);
  const transferKm = state.runs.reduce((a, r) =>
    a + r.bridges.reduce((b, t) => b + pathKm(t.points), 0), 0);

  let html = `<b>${state.runs.length}</b> continuous run${state.runs.length === 1 ? '' : 's'}` +
             ` &middot; <b>${fmtKm(riddenKm)} km</b> ridden`;
  if (transferKm > 0) {
    html += ` &middot; ${fmtKm(transferKm)} km by ferry, train or bus`;
  }

  // Name each remaining gap and say what is stopping it joining. A chain of
  // several transfers counts, so "nearly reached" usually means one leg is
  // short rather than that a whole transfer is missing.
  const breaks = state.runs.filter(r => r.breakAfter).map(r => r.breakAfter);
  if (breaks.length) {
    html += '<br><br>Gaps still open:';
    breaks.slice(0, 6).forEach(b => {
      html += `<br>&middot; <b>${fmtKm(b.gapKm)} km</b>` +
              (b.date ? ` before ${b.date}` : '');
      if (b.nearestKm == null) {
        html += ' — nothing drawn across it';
      } else if (b.nearestKm <= state.settings.tol * 3) {
        html += ` — <span class="warn">“${escapeHTML(b.nearestLabel)}” stops ` +
                `${fmtKm(b.nearestKm)} km short</span> (tolerance ${state.settings.tol} km)`;
      } else {
        html += ' — no drawn transfer reaches it';
      }
    });
    if (breaks.length > 6) html += `<br>&middot; …and ${breaks.length - 6} more`;
  }

  if (unmatched > 0) {
    html += `<br><br><span class="warn">${unmatched} transfer${unmatched === 1 ? '' : 's'} ` +
            `unused.</span> Transfers can chain — two trains in a row will join, ` +
            `provided each leg ends within ${state.settings.tol} km of the next.`;
  }
  el.innerHTML = html;
}

// ── Map ─────────────────────────────────────────────────────────────────────
// A 2.4px line against a fingertip is close to unhittable. Leaflet's canvas
// renderer adds `tolerance` to weight/2 when hit-testing, so the tap target
// grows without the drawn line changing at all.
const COARSE_POINTER = typeof matchMedia === 'function' &&
                       matchMedia('(pointer: coarse)').matches;
const HIT_TOLERANCE = COARSE_POINTER ? 15 : 5;

function initMap() {
  map = L.map('map', {
    preferCanvas: true,
    renderer: L.canvas({ tolerance: HIT_TOLERANCE }),
    zoomControl: true,
  }).setView([46, 6], 5);
  setBasemap(state.settings.basemap);
  haloLayer = L.layerGroup().addTo(map);   // below rideLayer: added first
  rideLayer = L.layerGroup().addTo(map);
  transferLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  animLayer = L.layerGroup().addTo(map);
}

/** Fetch a style and strip any globe projection from it.
 *
 *  MapLibre honours `projection` in the style document. Leaflet's own layers
 *  are always Web Mercator, so a globe basemap and the route lines disagree
 *  about where everything is. Patching the style up front is deterministic —
 *  calling setProjection() afterwards races the style load.
 *  Falls back to the plain URL if the fetch fails; the map still draws, it
 *  just may be a globe until reload.
 */
async function forceMercator(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const style = await res.json();
    style.projection = { type: 'mercator' };
    return style;
  } catch (e) {
    return url;
  }
}

/** Leaflet fits bounds to the whole container, but the profile panel and the
 *  scrubber float on top of it. Without this the fitted route runs underneath
 *  them. Returns the space each overlay is covering, in pixels. */
function mapPadding() {
  const bottomOf = (sel) => {
    const el = $(sel);
    if (!el || el.hidden) return 0;
    const box = el.getBoundingClientRect();
    const wrap = $('#map-wrap').getBoundingClientRect();
    return Math.max(0, wrap.bottom - box.top) + 8;
  };
  const bottom = Math.max(bottomOf('#profile'), bottomOf('#scrubber'));
  const card = $('#viewer-card');
  const top = (card && !card.hidden) ? card.getBoundingClientRect().height + 20 : 16;
  return { top, bottom: Math.max(bottom, 16) };
}

/** fitBounds that keeps the route clear of the floating panels. */
function fitBoundsPadded(bounds) {
  if (!bounds || !bounds.isValid || !bounds.isValid()) return;
  const p = mapPadding();
  map.fitBounds(bounds, {
    paddingTopLeft: [16, p.top],
    paddingBottomRight: [16, p.bottom],
    animate: false,
  });
}

/** Tell Leaflet the container changed size. Cheap, and safe to over-call. */
function resizeMap() {
  if (!map) return;
  requestAnimationFrame(() => map.invalidateSize({ animate: false }));
}

function setBasemap(kind) {
  const bm = BASEMAPS[kind] || BASEMAPS[Object.keys(BASEMAPS)[0]];
  const attribution = bm.attribution || OSM_ATTRIB;
  if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }

  if (bm.type === 'vector' && typeof L.maplibreGL === 'function') {
    const token = ++basemapToken;
    forceMercator(bm.style).then(style => {
      if (token !== basemapToken) return;   // a later switch won the race
      if (tileLayer) { map.removeLayer(tileLayer); }
      tileLayer = L.maplibreGL({ style, attribution }).addTo(map);
      if (tileLayer.bringToBack) tileLayer.bringToBack();
    });
    return;
  }

  if (bm.type === 'vector') {
    // MapLibre failed to load (offline, blocked CDN) — fall back to plain OSM
    // raster rather than leaving the map blank.
    log_fallback();
    tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: OSM_ATTRIB, maxZoom: 19,
    }).addTo(map);
  } else {
    const opts = { attribution, maxZoom: bm.maxZoom || 18 };
    if (bm.subdomains) opts.subdomains = bm.subdomains;
    tileLayer = L.tileLayer(bm.url, opts).addTo(map);
  }
  if (tileLayer && tileLayer.bringToBack) tileLayer.bringToBack();
}

// Guards against an older style arriving after a newer one was chosen.
let basemapToken = 0;

let warnedFallback = false;
function log_fallback() {
  if (warnedFallback) return;
  warnedFallback = true;
  toast('Vector basemap unavailable — using plain OpenStreetMap tiles', true);
}

/** Blue (earliest) → the brand colour (most recent). */
/** The ride's own colour as [r, g, b], blue at the start of the journey
 *  shifting to the chosen brand colour by the most recent ride. */
function rideRGB(i, total) {
  const hex = state.settings.brand.replace('#', '');
  const br = parseInt(hex.slice(0, 2), 16),
        bg = parseInt(hex.slice(2, 4), 16),
        bb = parseInt(hex.slice(4, 6), 16);
  const f = total < 2 ? 1 : i / (total - 1);
  return [
    Math.round(64 + (br - 64) * f),
    Math.round(120 + (bg - 120) * f),
    Math.round(200 + (bb - 200) * f),
  ];
}

/** Scale a colour toward black (f < 1) or white (f > 1). */
function shade([r, g, b], f) {
  const mix = (c) => f <= 1
    ? Math.round(c * f)
    : Math.round(c + (255 - c) * (f - 1));
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function rgba([r, g, b], alpha) { return `rgba(${r},${g},${b},${alpha})`; }

/** Kept for the ride list swatches and anything else wanting one colour. */
function rideColor(i, total) { return shade(rideRGB(i, total), 1); }

// The track is a dark core line. The glow is reserved for selection, so a
// clicked ride stands out against the plain lines around it.
const LINE_DARKEN        = 0.55;   // core line, relative to the ride's colour
const SELECT_HALO_WEIGHT = 13;
const SELECT_HALO_ALPHA  = 0.55;

function drawRides() {
  haloLayer.clearLayers();
  rideLayer.clearLayers();
  markerLayer.clearLayers();
  const eps = state.settings.simplify;
  state.rides.forEach((ride, i) => {
    const pts = simplify(ride.points, eps);
    const rgb = rideRGB(i, state.rides.length);

    // No halo here — it is the selection cue, drawn by highlightRide() for one
    // ride at a time. On every ride at once it was just visual noise.
    L.polyline(pts, {
      color: shade(rgb, LINE_DARKEN), weight: 2.4, opacity: 1,
      lineCap: 'round', lineJoin: 'round',
      // A thin line is hard to hit, especially on a phone.
      bubblingMouseEvents: false,
    }).bindTooltip(`${ride.date.slice(0, 10)} — ${ride.name} (${fmtKm(ride.dist)} km)`)
      .on('click', (e) => { L.DomEvent.stop(e); showRideProfile(ride); })
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
  if (all.length) fitBoundsPadded(L.latLngBounds(all));
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
      `<span class="sw" style="background:${shade(rideRGB(i, state.rides.length), LINE_DARKEN)};` +
      `box-shadow:0 0 0 2px ${rgba(rideRGB(i, state.rides.length), 0.3)}"></span>` +
      `<span class="nm" title="${escapeHTML(r.name)}">${escapeHTML(r.name)}</span>` +
      `<span class="meta">${r.date.slice(0, 10)} · ${fmtKm(r.dist)} km` +
      (r.ascent > 0 ? ` · ${Math.round(r.ascent).toLocaleString()} m` : '') +
      (fmtDuration(r.duration) ? ` · ${fmtDuration(r.duration)}` : '') + `</span>` +
      `<button class="del" title="Remove">✕</button>`;
    li.querySelector('.del').onclick = () => {
      state.rides.splice(i, 1); refreshAll(); persist();
    };
    li.onmouseenter = () => highlight(r.points);
    li.onmouseleave = () => clearHighlight();
    ul.appendChild(li);
  });
  renderRideStats();
}

/** Journey totals.
 *
 *  Distance, climbing and time count the recorded rides only. Transfers are
 *  drawn lines across ground that was covered by ferry, train or bus — adding
 *  them would inflate every figure with distance nobody pedalled.
 */
function rideTotals() {
  const rides = state.rides;
  const withAsc = rides.filter(r => r.ascent > 0);
  const withDur = rides.filter(r => r.duration > 0);
  return {
    count: rides.length,
    km: rides.reduce((a, r) => a + r.dist, 0),
    ascent: withAsc.reduce((a, r) => a + r.ascent, 0),
    seconds: withDur.reduce((a, r) => a + r.duration, 0),
    // Moving time only if every ride reports one; a mix would be misleading.
    elapsed: rides.length > 0 && rides.every(r => r.elapsed),
    missingAsc: rides.length - withAsc.length,
    missingDur: rides.length - withDur.length,
  };
}

function renderRideStats() {
  const box = $('#ride-stats');
  const label = $('#rides-count');
  if (!state.rides.length) {
    box.hidden = true;
    label.textContent = 'No rides yet';
    return;
  }

  const s = rideTotals();
  label.textContent = `${s.count} ride${s.count === 1 ? '' : 's'}`;

  const cells = [
    [`${fmtKm(s.km)} km`, 'ridden'],
    [`${s.count}`, s.count === 1 ? 'ride' : 'rides'],
  ];
  if (s.ascent > 0) cells.push([`${Math.round(s.ascent).toLocaleString()} m`, 'climbed']);
  const dur = fmtDuration(s.seconds);
  if (dur) cells.push([dur, s.elapsed ? 'elapsed' : 'moving time']);

  let html = cells.map(([v, k]) =>
    `<div><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

  // Say so when the figures cover only some of the rides, rather than quietly
  // reporting a total that is missing files without the data.
  const gaps = [];
  if (s.missingAsc && s.ascent > 0) gaps.push(`${s.missingAsc} without elevation`);
  if (s.missingDur && s.seconds > 0) gaps.push(`${s.missingDur} without timings`);
  if (gaps.length) html += `<div class="note">Excludes ${gaps.join(' and ')}.</div>`;
  if (state.transfers.length) {
    const tk = state.transfers.reduce((a, t) => a + pathKm(t.points), 0);
    html += `<div class="note">Transfers are not counted: ` +
            `${fmtKm(tk)} km by ferry, train or bus.</div>`;
  }

  box.innerHTML = html;
  box.hidden = false;
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
  syncProfileButton();
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
  // Never write while showing somebody else's published map. The viewer loads
  // their project into `state`, so saving here would silently replace your own.
  if (typeof document !== 'undefined' &&
      document.body && document.body.classList.contains('viewing')) return;
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
  $('#brand').value = state.settings.brand;
  $('#simplify').value = state.settings.simplify;
  $('#simplify-val').textContent = state.settings.simplify;
  $('#tol').value = state.settings.tol;
  $('#tol-val').textContent = state.settings.tol;
  if (!(state.settings.basemap in BASEMAPS)) {
    state.settings.basemap = Object.keys(BASEMAPS)[0];
  }
  setBasemap(state.settings.basemap);
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
        run: i + 1,
        points: r.points.length,
        distance_km: +r.km.toFixed(1),            // whole line, transfers included
        transfer_km: +r.bridges.reduce((a, t) => a + pathKm(t.points), 0).toFixed(1),
        bridged_by: r.bridges.map(b => `${b.mode}: ${b.label}`),
      },
      geometry: {
        type: 'LineString',
        coordinates: r.points.map(([lat, lon, el]) =>
          (el != null && isFinite(el))
            ? [+lon.toFixed(5), +lat.toFixed(5), +el.toFixed(1)]
            : [+lon.toFixed(5), +lat.toFixed(5)]),
      },
    })),
  };
}

function runsGPX() {
  const esc = escapeHTML;
  const segs = state.runs.map(r =>
    '  <trkseg>\n' +
    r.points.map(([la, lo, el]) =>
      (el != null && isFinite(el))
        ? `   <trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"><ele>${el.toFixed(1)}</ele></trkpt>`
        : `   <trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>`).join('\n') +
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
  const totals = rideTotals();
  const payload = {
    name: state.name,
    stats: {
      rides: totals.count,
      km: Math.round(totals.km),
      ascent: Math.round(totals.ascent),
      dur: fmtDuration(totals.seconds),
      elapsed: totals.elapsed,
      transferKm: Math.round(
        state.transfers.reduce((a, t) => a + pathKm(t.points), 0)),
    },
    brand: state.settings.brand,
    basemap: state.settings.basemap,
    rides: state.rides.map((r, i) => ({
      n: r.name, d: r.date.slice(0, 10), km: +r.dist.toFixed(1),
      c: shade(rideRGB(i, state.rides.length), LINE_DARKEN),
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
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css">
<style>
 html,body{height:100%;margin:0;background:#0d0d0a;color:#f0ebe3;
   font:14px/1.5 system-ui,sans-serif}
 #map{position:absolute;inset:0}
 #title{position:absolute;top:14px;left:56px;z-index:900;background:rgba(12,12,9,.82);
   border-left:4px solid ${state.settings.brand};border-radius:8px;padding:9px 15px;
   box-shadow:0 2px 12px rgba(0,0,0,.5)}
 #title h1{margin:0;font-size:17px;letter-spacing:.03em}
 #title small{color:#a19a8f;display:block}
 #title #sub2{font-size:11px;opacity:.75}
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
<div id="title"><h1>${escapeHTML(state.name)}</h1><small id="sub"></small><small id="sub2"></small></div>
<div id="legend"></div>
<div id="bar"><button id="pp">▶</button><input id="pr" type="range" min="0" max="1000" value="0"><span id="lbl"></span></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script src="https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js"><\/script>
<script src="https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js"><\/script>
<script>
const D=${JSON.stringify(payload)};
const MODES=${JSON.stringify(MODES)};
const TILES=${JSON.stringify(BASEMAPS)};
const map=L.map('map',{preferCanvas:true}).setView([46,6],5);
const bm=TILES[D.basemap]||TILES[Object.keys(TILES)[0]];
if(bm.type==='vector'&&typeof L.maplibreGL==='function'){
  /* strip any globe projection: Leaflet overlays are Web Mercator */
  fetch(bm.style).then(r=>r.json()).then(st=>{
    st.projection={type:'mercator'};
    L.maplibreGL({style:st,attribution:bm.attribution}).addTo(map).bringToBack();
  }).catch(()=>{
    L.maplibreGL({style:bm.style,attribution:bm.attribution}).addTo(map);
  });
}else if(bm.type==='vector'){
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:bm.attribution,maxZoom:19}).addTo(map);
}else{
  L.tileLayer(bm.url,Object.assign({attribution:bm.attribution,maxZoom:bm.maxZoom||18},bm.subdomains?{subdomains:bm.subdomains}:{})).addTo(map);
}
const all=[];
D.rides.forEach(r=>{L.polyline(r.p,{color:r.c,weight:2.4,opacity:1,lineCap:'round',lineJoin:'round'})
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
/* Ridden figures only. The animated total below includes transfers,
   which is not what these numbers are for. */
(function(){
  const S=D.stats||{};
  const bits=[S.rides+' rides', (S.km||0).toLocaleString()+' km ridden'];
  if(S.ascent>0) bits.push(S.ascent.toLocaleString()+' m climbed');
  if(S.dur) bits.push(S.dur+(S.elapsed?' elapsed':' moving'));
  document.getElementById('sub').textContent=bits.join(' · ');
  if(S.transferKm>0){
    const e=document.getElementById('sub2');
    if(e) e.textContent='plus '+S.transferKm.toLocaleString()+' km by ferry, train or bus';
  }
})();
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
  if (kind === 'publish') { publish(); return; }
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



// ── Elevation profile ───────────────────────────────────────────────────────
// Distance along the bottom, height up the side. Transfers are excluded by
// construction: the series is built from ride points only, so a ferry leg is a
// join between rides rather than a stretch of the graph.

const profile = { series: [], ride: null, marker: null, hi: null, w: 1000, h: 104 };

/** [{km, ele, pt}] for a set of rides, distance accumulating across them.
 *  Rides without elevation are skipped — they would otherwise read as a drop
 *  to zero and wreck the vertical scale. */
function buildProfile(rides) {
  const out = [];
  let km = 0;
  for (const r of rides) {
    const pts = r.points;
    const hasEle = pts.some(p => p[2] != null && isFinite(p[2]));
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) km += haversineKm(pts[i - 1], pts[i]);
      const e = pts[i][2];
      if (hasEle && e != null && isFinite(e)) out.push({ km, ele: e, pt: pts[i] });
    }
  }
  return out;
}

/** Thin to about one sample per pixel — an SVG path with 50k points is
 *  pointless and slow. Keeps the extremes of each bucket so peaks survive. */
function thinProfile(series, targetPts) {
  if (series.length <= targetPts) return series;
  const bucket = series.length / targetPts;
  const out = [];
  for (let b = 0; b < targetPts; b++) {
    const a = Math.floor(b * bucket), z = Math.min(series.length, Math.floor((b + 1) * bucket));
    if (z <= a) continue;
    let lo = series[a], hi = series[a];
    for (let i = a; i < z; i++) {
      if (series[i].ele < lo.ele) lo = series[i];
      if (series[i].ele > hi.ele) hi = series[i];
    }
    // keep them in distance order so the line reads left to right
    if (lo.km <= hi.km) out.push(lo, hi); else out.push(hi, lo);
  }
  return out;
}

// Margins hold the axis labels. In pixels, because the SVG is now drawn at
// its real size — a stretched viewBox would squash the text.
const PLOT = { left: 46, right: 10, top: 8, bottom: 18 };

/** Round numbers a person would actually label an axis with.
 *
 *  Picks the nearest of 1/2/2.5/5/10 × 10^n to the ideal spacing. Rounding up
 *  instead — the obvious shortcut — overshoots badly on ranges that do not
 *  start at zero: 112–1840 m wanted a 500 m step and got 1000, leaving one
 *  lonely gridline at 1000.
 */
function niceTicks(lo, hi, want) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];

  const ideal = span / Math.max(1, want);
  const mag = Math.pow(10, Math.floor(Math.log10(ideal)));
  const norm = ideal / mag;
  const step = [1, 2, 2.5, 5, 10]
    .reduce((best, m) => Math.abs(m - norm) < Math.abs(best - norm) ? m : best, 1) * mag;

  const build = (st) => {
    // Multiply out from an index rather than accumulating: repeated += on a
    // fractional step drifts (0.1 + 0.1 + 0.1 = 0.30000000000000004).
    const dp = Math.max(0, -Math.floor(Math.log10(st)) + 1);
    const first = Math.ceil(lo / st);
    const out = [];
    for (let k = first; k * st <= hi + 1e-9; k++) {
      const v = +(k * st).toFixed(dp);
      out.push(Object.is(v, -0) ? 0 : v);
    }
    return out;
  };

  let ticks = build(step);
  // A range that lands awkwardly can still yield too few; halving recovers it.
  if (ticks.length < 2) ticks = build(step / 2);
  if (ticks.length < 2) ticks = [lo, hi];
  return ticks;
}

function renderProfile() {
  const svg = $('#p-svg');
  const series = profile.series;
  if (series.length < 2) {
    svg.innerHTML = '';
    const fromRw = state.rides.some(r => r.srcId);
    $('#p-stats').textContent = fromRw
      ? 'No elevation on these rides — run Fetch rides again to pull it in'
      : 'No elevation in these files — the GPX has no <ele> values';
    $('#p-readout').textContent = '';
    return;
  }

  // Draw at the element's real pixel size so axis text is not distorted.
  const rect = svg.getBoundingClientRect();
  const W = Math.max(240, Math.round(rect.width));
  const H = Math.max(60, Math.round(rect.height));
  const x0 = PLOT.left, x1 = W - PLOT.right;
  const y0 = PLOT.top,  y1 = H - PLOT.bottom;

  const maxKm = series[series.length - 1].km || 1;
  let lo = Infinity, hi = -Infinity;
  for (const s of series) { if (s.ele < lo) lo = s.ele; if (s.ele > hi) hi = s.ele; }
  // A flat ride would otherwise divide by zero and fill the panel with noise.
  if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
  const span = hi - lo;

  Object.assign(profile, { W, H, x0, x1, y0, y1, maxKm, lo, span });

  const X = km  => x0 + (km / maxKm) * (x1 - x0);
  const Y = ele => y0 + (1 - (ele - lo) / span) * (y1 - y0);

  const thin = thinProfile(series, Math.round((x1 - x0) * 1.5));
  let d = `M ${X(thin[0].km).toFixed(1)} ${Y(thin[0].ele).toFixed(1)}`;
  for (let i = 1; i < thin.length; i++) {
    d += ` L ${X(thin[i].km).toFixed(1)} ${Y(thin[i].ele).toFixed(1)}`;
  }
  const area = `${d} L ${X(maxKm).toFixed(1)} ${y1} L ${x0} ${y1} Z`;

  const brand = state.settings.brand;
  const grid = [], labels = [];

  for (const e of niceTicks(lo, hi, H < 90 ? 2 : 3)) {
    const y = Y(e).toFixed(1);
    grid.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="#ffffff14"/>`);
    labels.push(`<text x="${x0 - 7}" y="${y}" text-anchor="end" dominant-baseline="middle"` +
                ` class="ax">${Math.round(e).toLocaleString()}</text>`);
  }
  for (const km of niceTicks(0, maxKm, W < 520 ? 3 : 6)) {
    const x = X(km).toFixed(1);
    grid.push(`<line x1="${x}" x2="${x}" y1="${y0}" y2="${y1}" stroke="#ffffff0e"/>`);
    labels.push(`<text x="${x}" y="${y1 + 13}" text-anchor="middle" class="ax">` +
                `${km >= 1000 ? Math.round(km).toLocaleString() : +km.toFixed(km < 10 ? 1 : 0)}</text>`);
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML =
    `<defs><linearGradient id="pg" x1="0" x2="0" y1="0" y2="1">` +
      `<stop offset="0%" stop-color="${brand}" stop-opacity=".45"/>` +
      `<stop offset="100%" stop-color="${brand}" stop-opacity="0"/></linearGradient></defs>` +
    grid.join('') +
    `<path d="${area}" fill="url(#pg)"/>` +
    `<path d="${d}" fill="none" stroke="${brand}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<line x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}" stroke="#ffffff2a"/>` +
    labels.join('') +
    `<text x="${x1}" y="${y1 + 13}" text-anchor="end" class="ax dim">km</text>` +
    `<text x="${x0 - 7}" y="${y0 - 1}" text-anchor="end" class="ax dim">m</text>` +
    `<line id="p-cursor" x1="0" y1="${y0}" x2="0" y2="${y1}" stroke="#fff"` +
    ` stroke-width="1" opacity="0"/>`;

  $('#p-stats').textContent =
    `${fmtKm(maxKm)} km · ${Math.round(lo).toLocaleString()}–${Math.round(hi).toLocaleString()} m`;
}

/** Follow the pointer: move a dot on the map and read out the numbers. */
function profileAt(clientX) {
  const svg = $('#p-svg');
  const series = profile.series;
  if (series.length < 2 || profile.x1 == null) return;

  // The SVG is drawn at its real pixel size, so CSS pixels and viewBox units
  // line up and the plot inset can be subtracted directly.
  const box = svg.getBoundingClientRect();
  const px = Math.min(profile.x1, Math.max(profile.x0, clientX - box.left));
  const frac = (px - profile.x0) / Math.max(1, profile.x1 - profile.x0);

  const targetKm = frac * profile.maxKm;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (series[m].km < targetKm) lo = m + 1; else hi = m; }
  const s = series[lo];

  const cur = svg.querySelector('#p-cursor');
  if (cur) { cur.setAttribute('x1', px); cur.setAttribute('x2', px); cur.setAttribute('opacity', '1'); }

  if (!profile.marker) {
    profile.marker = L.circleMarker(s.pt, { radius: 6, color: '#fff', weight: 2,
      fillColor: state.settings.brand, fillOpacity: 1 }).addTo(map);
  } else {
    profile.marker.setLatLng(s.pt);
  }
  $('#p-readout').textContent =
    `${fmtKm(s.km)} km · ${Math.round(s.ele).toLocaleString()} m`;
}

function clearProfileCursor() {
  const cur = $('#p-svg').querySelector('#p-cursor');
  if (cur) cur.setAttribute('opacity', '0');
  if (profile.marker) { map.removeLayer(profile.marker); profile.marker = null; }
  $('#p-readout').textContent = '';
}

/** Whole journey: every ride, transfers excluded by construction. */
function showJourneyProfile() {
  profile.ride = null;
  profile.rideBits = null;
  profile.series = buildProfile(state.rides);
  clearRideHighlight();
  $('#p-title').textContent = state.name || 'Whole journey';
  $('#p-back').hidden = true;
  openProfile();
}

/** One ride, with its own stats and the segment picked out on the map. */
function showRideProfile(ride) {
  profile.ride = ride;
  profile.series = buildProfile([ride]);
  highlightRide(ride);

  const bits = [ride.date.slice(0, 10), `${fmtKm(ride.dist)} km`];
  if (ride.ascent > 0) bits.push(`${Math.round(ride.ascent).toLocaleString()} m climbed`);
  const d = fmtDuration(ride.duration);
  if (d) bits.push(d + (ride.elapsed ? ' elapsed' : ' moving'));
  profile.rideBits = bits;

  $('#p-title').textContent = ride.name;
  $('#p-back').hidden = state.rides.length < 2;
  openProfile();
  // After openProfile(), so mapPadding() can measure the panel.
  fitToRide(ride);

}

function openProfile() {
  $('#profile').hidden = false;
  $('#p-show').hidden = true;
  renderProfile();
  // Ride stats sit alongside the elevation range rather than replacing it.
  if (profile.rideBits && profile.ride) {
    $('#p-stats').textContent = profile.rideBits.join(' · ') + ' · ' + $('#p-stats').textContent;
  }
  resizeMap();
}

function closeProfile() {
  $('#profile').hidden = true;
  $('#p-show').hidden = !state.rides.length;
  clearProfileCursor();
  clearRideHighlight();
  profile.ride = null;
  resizeMap();
}

/** Show the Elevation button only when some ride actually carries elevation. */
function syncProfileButton() {
  const any = state.rides.some(r =>
    r.points.some(p => p[2] != null && isFinite(p[2])));
  const open = !$('#profile').hidden;
  $('#p-show').hidden = !any || open;
  if (!any && open) closeProfile();
  document.body.classList.toggle('has-scrubber', !$('#scrubber').hidden);
}

let rideHighlight = null;          // [layers] — glow, line and end caps

/** Pick one ride out of the journey.
 *
 *  The glow is the selection cue — it appears here and nowhere else, so a
 *  highlighted segment reads instantly against the plain dark lines around it.
 *  Caps mark where the ride began and ended, which a brighter line alone does
 *  not convey. Drawing only; the fit is separate so it can happen after the
 *  profile panel is on screen and its height is known.
 */
function highlightRide(ride) {
  clearRideHighlight();
  const i = state.rides.indexOf(ride);
  const rgb = rideRGB(i < 0 ? state.rides.length - 1 : i, state.rides.length);
  const pts = simplify(ride.points, state.settings.simplify);
  const a = pts[0], b = pts[pts.length - 1];

  const glow = L.polyline(pts, {
    color: rgba(rgb, SELECT_HALO_ALPHA), weight: SELECT_HALO_WEIGHT,
    lineCap: 'round', lineJoin: 'round', interactive: false,
  }).addTo(haloLayer);

  const line = L.polyline(pts, {
    color: '#fff', weight: 2.6, opacity: .95,
    lineCap: 'round', lineJoin: 'round', interactive: false,
  }).addTo(haloLayer);

  const cap = (pt, fill, label) =>
    L.circleMarker(pt, { radius: 7, color: '#15150f', weight: 2,
                         fillColor: fill, fillOpacity: 1, interactive: true })
     .bindTooltip(label, { direction: 'top' })
     .addTo(haloLayer);

  rideHighlight = [
    glow, line,
    cap(a, '#8fbf6f', `Start — ${ride.date.slice(0, 10)}`),
    cap(b, shade(rgb, 1.15), `End — ${fmtKm(ride.dist)} km`),
  ];
}

/** Is this map point within `px` screen pixels of the ride's line? */
function nearRide(latlng, ride, px) {
  const p = map.latLngToLayerPoint(latlng);
  const pts = simplify(ride.points, Math.max(state.settings.simplify, 25));
  for (const c of pts) {
    if (map.latLngToLayerPoint(L.latLng(c[0], c[1])).distanceTo(p) <= px) return true;
  }
  return false;
}

function fitToRide(ride) {
  fitBoundsPadded(L.latLngBounds(simplify(ride.points, state.settings.simplify)));
}

function clearRideHighlight() {
  if (!rideHighlight) return;
  rideHighlight.forEach(l => haloLayer.removeLayer(l));
  rideHighlight = null;
}

// ── Publishing ──────────────────────────────────────────────────────────────
// A published map is one Firestore document: the project, gzipped and
// base64'd, under the 1 MiB document ceiling. No SDK — the REST API is two
// fetches, and avoids shipping ~200 KB of client library for them.
//
// The document id is the only secret, which is what makes a link unlisted.
// Published maps are immutable (see firestore.rules), so a link you have given
// out cannot change underneath whoever you gave it to.

const FB = (typeof window !== 'undefined' && window.ROUTE_STUDIO_FIREBASE) || {};
const FIRESTORE_MAX = 1048576;          // hard Firestore document limit
const PUBLISH_BUDGET = 900000;          // leave room for the other fields

function publishConfigured() { return !!(FB.projectId && FB.apiKey); }

function fbBase() {
  return `https://firestore.googleapis.com/v1/projects/${FB.projectId}` +
         `/databases/(default)/documents/published`;
}
/** GET one published map. */
function fbReadUrl(id) {
  return `${fbBase()}/${encodeURIComponent(id)}?key=${encodeURIComponent(FB.apiKey)}`;
}
/** POST a new one at a chosen id. Firestore takes the id as a query param. */
function fbCreateUrl(id) {
  return `${fbBase()}?documentId=${encodeURIComponent(id)}&key=${encodeURIComponent(FB.apiKey)}`;
}

/** Unguessable, URL-safe, no lookalike characters. */
function shareId(len = 12) {
  const alphabet = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

async function gzipToBase64(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  // btoa chokes on very long argument lists, so feed it in chunks.
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function base64ToText(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** The project as published: simplified for viewing, full fidelity dropped.
 *  Viewers get a map, not a data archive — and the payload has to fit. */
function publishPayload(simplifyM) {
  const eps = Math.max(state.settings.simplify, simplifyM);
  const totals = rideTotals();
  return {
    v: 1,
    name: state.name,
    settings: { brand: state.settings.brand, basemap: state.settings.basemap,
                simplify: state.settings.simplify, tol: state.settings.tol },
    stats: {
      rides: totals.count, km: Math.round(totals.km),
      ascent: Math.round(totals.ascent), dur: fmtDuration(totals.seconds),
      elapsed: totals.elapsed,
      transferKm: Math.round(state.transfers.reduce((a, t) => a + pathKm(t.points), 0)),
    },
    rides: state.rides.map(r => ({
      id: r.id, name: r.name, date: r.date, dist: r.dist,
      ascent: r.ascent || 0, duration: r.duration || null, elapsed: !!r.elapsed,
      points: simplify(r.points, eps).map(p =>
        p.length > 2 ? [+p[0].toFixed(5), +p[1].toFixed(5), +p[2].toFixed(1)]
                     : [+p[0].toFixed(5), +p[1].toFixed(5)]),
    })),
    transfers: state.transfers.map(t => ({
      id: t.id, mode: t.mode, label: t.label,
      points: t.points.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]),
    })),
  };
}

async function publish() {
  if (!state.rides.length) { toast('Add some rides first', true); return; }
  if (typeof CompressionStream === 'undefined') {
    toast('This browser cannot compress — try Chrome, Edge, Safari 16.4+ or Firefox 113+', true);
    return;
  }
  if (!publishConfigured()) {
    toast('Sharing is not configured — see "Publishing" in the README', true);
    return;
  }

  status('Preparing…');
  try {
    // Coarsen until it fits. 10 m is already invisible at map zoom; the later
    // steps only matter for journeys several times the size of a season.
    let payload = null, b64 = null;
    for (const eps of [10, 15, 20, 30, 50, 80]) {
      payload = publishPayload(eps);
      b64 = await gzipToBase64(JSON.stringify(payload));
      if (b64.length <= PUBLISH_BUDGET) break;
    }
    if (b64.length > PUBLISH_BUDGET) {
      toast(`Too large to publish (${(b64.length / 1048576).toFixed(1)} MB after ` +
            `compression; the limit is 1 MB). Remove some rides and try again.`, true);
      status('');
      return;
    }

    status('Publishing…');
    const id = shareId();
    const res = await fetch(fbCreateUrl(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        payload:   { stringValue: b64 },
        name:      { stringValue: state.name.slice(0, 199) },
        createdAt: { timestampValue: new Date().toISOString() },
        points:    { integerValue: String(payload.rides.reduce((a, r) => a + r.points.length, 0)) },
      }}),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(res.status === 403
        ? 'Firestore refused the write — check firestore.rules is deployed'
        : `Firestore returned HTTP ${res.status}: ${body.slice(0, 160)}`);
    }

    status('');
    showShareLink(id, b64.length);
  } catch (e) {
    status('');
    toast('Could not publish: ' + e.message, true);
  }
}

function shareUrlFor(id) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return `${base}?p=${id}`;
}

function showShareLink(id, bytes) {
  const url = shareUrlFor(id);
  $('#share-url').value = url;
  $('#share-note').textContent =
    `Anyone with this link can view the map. It cannot be edited once published, ` +
    `and it is not listed anywhere — the link is the only way in. ` +
    `(${(bytes / 1024).toFixed(0)} KB)`;
  $('#share-modal').hidden = false;
  $('#share-url').select();
}

/** Load a published map into the viewer. */
async function openPublished(id) {
  document.body.classList.add('viewing');
  // The map was sized with the panel and topbar on screen. Hiding them does
  // not tell Leaflet anything, so without this it keeps painting at the old
  // size — a dead strip on the right, and below the fold on mobile.
  resizeMap();
  status('Loading…');
  try {
    if (!publishConfigured()) throw new Error('sharing is not configured on this copy');
    const res = await fetch(fbReadUrl(id));
    if (res.status === 404) throw new Error('that link does not exist, or was removed');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const b64 = doc.fields && doc.fields.payload && doc.fields.payload.stringValue;
    if (!b64) throw new Error('that link has no map on it');

    const data = JSON.parse(await base64ToText(b64));
    state.name = data.name || 'Shared journey';
    state.rides = (data.rides || []).map(r => ({ ...r, points: r.points }));
    state.transfers = data.transfers || [];
    Object.assign(state.settings, data.settings || {});

    refreshAll();
    fitAll();

    const S = data.stats || {};
    $('#viewer-title').textContent = state.name;
    const bits = [`${S.rides || state.rides.length} rides`];
    if (S.km) bits.push(`${S.km.toLocaleString()} km ridden`);
    if (S.ascent > 0) bits.push(`${S.ascent.toLocaleString()} m climbed`);
    if (S.dur) bits.push(S.dur + (S.elapsed ? ' elapsed' : ' moving'));
    $('#viewer-stats').textContent = bits.join(' · ');
    $('#viewer-stats2').textContent = S.transferKm > 0
      ? `plus ${S.transferKm.toLocaleString()} km by ferry, train or bus` : '';
    $('#viewer-card').hidden = false;
    $('#scrubber').hidden = anim.path.length < 2;
    status('');
  } catch (e) {
    status('');
    document.body.classList.remove('viewing');
    toast('Could not open that link: ' + e.message, true);
  }
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

  // Share sheet
  $('#share-copy').onclick = async () => {
    const url = $('#share-url').value;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (e) {
      $('#share-url').select();          // clipboard blocked — let them copy by hand
      toast('Press ⌘C / Ctrl+C to copy', true);
    }
  };
  $('#share-open').onclick = () => window.open($('#share-url').value, '_blank');
  $('#share-close').onclick = () => { $('#share-modal').hidden = true; };
  $('#share-modal').addEventListener('click', e => {
    if (e.target.id === 'share-modal') $('#share-modal').hidden = true;
  });

  // Clicking bare map drops the selection. On touch a near-miss is common, so
  // only treat it as a deselect when the tap was well clear of the chosen ride.
  map.on('click', (e) => {
    if (!profile.ride) return;
    if (COARSE_POINTER && nearRide(e.latlng, profile.ride, HIT_TOLERANCE * 2)) return;
    showJourneyProfile();
  });

  // Elevation profile
  $('#p-close').onclick = closeProfile;
  $('#p-show').onclick = showJourneyProfile;
  $('#p-back').onclick = showJourneyProfile;

  const svg = $('#p-svg');
  const track = e => {
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    profileAt(x);
  };
  svg.addEventListener('pointermove', track);
  svg.addEventListener('pointerdown', track);
  svg.addEventListener('pointerleave', clearProfileCursor);
  svg.addEventListener('touchmove', e => { e.preventDefault(); track(e); }, { passive: false });

  let profileRedraw;
  const onViewportChange = () => {
    resizeMap();
    // Axis ticks are laid out in pixels, so the plot has to be redrawn.
    clearTimeout(profileRedraw);
    profileRedraw = setTimeout(() => { if (!$('#profile').hidden) renderProfile(); }, 120);
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

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

  // A ?p= link is somebody else's map: show it read-only and never touch the
  // local project, so opening a shared link cannot overwrite your own work.
  const shared = new URLSearchParams(location.search).get('p');
  if (shared) {
    $('#viewer-open').href = location.pathname;
    await openPublished(shared);
    return;
  }

  await restore();
  refreshAll();
  if (state.rides.length) fitAll();
})();
