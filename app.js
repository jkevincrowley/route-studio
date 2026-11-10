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
// vector tiles (open source, versatiles.org), rendered by MapLibre GL, which
// also draws the route itself and owns the camera.
//
// NOTE: this style ships `projection: {type: "globe"}`, which loadStyle()
// rewrites to Mercator. That used to be mandatory — Leaflet's overlays were
// Mercator-only, so a globe slid out from under the route — and is now just
// a choice about how the map should look.
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
  // Scrollytelling: chapters spanning a range of rides, each with its own
  // text and photo URLs. Empty until you write one.
  chapters: [],     // {id, title, text, fromRideId, toRideId, photos:[{url,caption}]}
};

let map, mapReady = false;
let drawMode = 'ferry';
// In-progress transfer drawing: MapLibre has no draw plugin, and the whole
// interaction is a vertex list plus a rubber-band segment to the cursor.
const draw = { on: false, pts: [] };
const anim = { raf: null, playing: false, t: 0, dot: null, segs: [], trailIds: [],
               path: [], breaks: new Set(), cum: [], total: 0 };

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

/** ISO date to mm-dd-yy. The list is tight and the year rarely varies. */
function fmtShortDate(iso) {
  const d = String(iso).slice(0, 10).split('-');   // yyyy-mm-dd
  return d.length === 3 ? `${d[1]}-${d[2]}-${d[0].slice(2)}` : String(iso).slice(0, 10);
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
// MapLibre GL *is* the map: it owns the camera and draws the route as GL
// layers. It used to render only the basemap, inside Leaflet, which left
// Leaflet driving the camera — zoom moved in whole steps, and every pan
// re-projected and repainted 200k route points onto a 2D canvas on the main
// thread. Giving both jobs to the GPU is what makes panning and zooming
// continuous; nothing about the route data changed.
//
// Coordinates: the app stores [lat, lon] everywhere, GeoJSON wants [lon, lat].
// That flip happens only in the feature builders below, so no other code has
// to think about it.

const COARSE_POINTER = typeof matchMedia === 'function' &&
                       matchMedia('(pointer: coarse)').matches;
// A 2.4px line against a fingertip is close to unhittable, so a click queries
// a box around the pointer rather than the exact pixel under it.
const HIT_TOLERANCE = COARSE_POINTER ? 15 : 5;

const EMPTY = { type: 'FeatureCollection', features: [] };
const fc = (features) => ({ type: 'FeatureCollection', features });

function lineFeature(pts, props) {
  const c = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) c[i] = [pts[i][1], pts[i][0]];
  return { type: 'Feature', properties: props || {},
           geometry: { type: 'LineString', coordinates: c } };
}
function pointFeature(pt, props) {
  return { type: 'Feature', properties: props || {},
           geometry: { type: 'Point', coordinates: [pt[1], pt[0]] } };
}
function setData(id, data, m) {
  const target = m || map;
  if (!target) return;
  const src = target.getSource(id);
  if (src) src.setData(data);
}

/** [[w, s], [e, n]] for a list of [lat, lon] points, or null if there are none. */
function boundsOf(pts) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) {
    if (!p) continue;
    if (p[1] < w) w = p[1];
    if (p[1] > e) e = p[1];
    if (p[0] < s) s = p[0];
    if (p[0] > n) n = p[0];
  }
  return isFinite(w) ? [[w, s], [e, n]] : null;
}

/** Raster OpenStreetMap, used only if the vector style cannot be fetched.
 *  MapLibre has nothing at all to draw without a style, so the fallback is
 *  not optional the way it was when Leaflet held the tiles. */
const RASTER_FALLBACK = {
  version: 8,
  sources: {
    osm: { type: 'raster', tileSize: 256,
           tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
           attribution: OSM_ATTRIB },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/** Fetch the basemap style and pin it to Mercator.
 *
 *  The globe used to be actively wrong: Leaflet drew its overlays in Web
 *  Mercator, so the basemap slid out from under the route. Every overlay is a
 *  GL layer now, so a globe would line up — Mercator is kept only because it
 *  is how the map has always looked. Dropping this one line tries the globe.
 */
async function loadStyle(bm) {
  try {
    const res = await fetch(bm.style);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const style = await res.json();
    style.projection = { type: 'mercator' };
    return style;
  } catch (e) {
    toast('Vector basemap unavailable — using plain OpenStreetMap tiles', true);
    return RASTER_FALLBACK;
  }
}

async function initMap() {
  const bm = BASEMAPS[state.settings.basemap] || BASEMAPS[Object.keys(BASEMAPS)[0]];
  const style = await loadStyle(bm);

  map = new maplibregl.Map({
    container: 'map',
    style,
    center: [6, 46],
    zoom: 3.6,
    attributionControl: { compact: true },
    antialias: true,
    fadeDuration: 150,        // labels crossfade instead of popping mid-zoom
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
  // Pinch still zooms continuously, but a stray two-finger twist no longer
  // spins the map out from under someone who meant to scroll.
  map.touchZoomRotate.disableRotation();

  // Layers need the style, and MapLibre only loads a style once it has a
  // frame to render into — a background tab renders nothing, so `load` can be
  // minutes away or never. Resolving as soon as the map object exists lets the
  // sidebar, the importer and every other control work meanwhile; the map
  // draws itself when it is finally looked at.
  map.once('load', () => {
    addMapLayers(map);
    mapReady = true;
    refreshAll();
    if (state.rides.length) fitAll({ animate: false });
  });
}

/** Every source and layer the app draws into, created once, in paint order.
 *
 *  Sources start empty and are filled by setData afterwards, so the drawing
 *  functions never add or remove layers. A layer that always exists is also a
 *  stable anchor for slotting the animation trail in at the right depth.
 */
function addMapLayers(m) {
  ['src-hover', 'src-sel', 'src-rides', 'src-transfers', 'src-draw',
   'src-ends', 'src-sel-caps']
    .forEach(id => m.addSource(id, { type: 'geojson', data: EMPTY }));

  m.addLayer({
    id: 'lyr-hover', type: 'line', source: 'src-hover',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': 6, 'line-opacity': .5 },
  });

  // Selection halo. The soft edge is line-blur, which the 2D canvas could not do.
  m.addLayer({
    id: 'lyr-sel-glow', type: 'line', source: 'src-sel',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'],
             'line-width': SELECT_HALO_WEIGHT, 'line-blur': 3 },
  });

  m.addLayer({
    id: 'lyr-rides', type: 'line', source: 'src-rides',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      // One fixed pixel width has to suit both a whole continent and a single
      // valley. The ramp keeps the line in proportion to what is on screen.
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 9, 2.6, 14, 4],
    },
  });

  // line-dasharray cannot be data-driven, so each mode gets its own layer.
  // Leaflet measures dashes in pixels; MapLibre counts them in line widths.
  Object.entries(MODES).forEach(([key, st]) => {
    m.addLayer({
      id: 'lyr-tr-' + key, type: 'line', source: 'src-transfers',
      filter: ['==', ['get', 'mode'], key],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': st.color, 'line-width': 3,
               'line-dasharray': st.dash.split(',').map(n => +n / 3) },
    });
  });

  m.addLayer({
    id: 'lyr-sel-line', type: 'line', source: 'src-sel',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': 2.6, 'line-opacity': .95 },
  });

  m.addLayer({
    id: 'lyr-draw-line', type: 'line', source: 'src-draw',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 3,
             'line-dasharray': [2, 2] },
  });

  // Anchor layer: trail segments are inserted before this one, so the start
  // and end markers stay on top of the moving line.
  m.addLayer({
    id: 'lyr-ends', type: 'circle', source: 'src-ends',
    paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'],
             'circle-stroke-width': 1.5, 'circle-stroke-color': '#15150f' },
  });

  m.addLayer({
    id: 'lyr-sel-caps', type: 'circle', source: 'src-sel-caps',
    paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'],
             'circle-stroke-width': 2, 'circle-stroke-color': '#15150f' },
  });

  m.addLayer({
    id: 'lyr-draw-pts', type: 'circle', source: 'src-draw',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 4, 'circle-color': ['get', 'color'],
             'circle-stroke-width': 1.5, 'circle-stroke-color': '#15150f' },
  });

  if (m === map) {
    hoverLabel(['lyr-rides', 'lyr-ends', 'lyr-sel-caps',
      ...Object.keys(MODES).map(k => 'lyr-tr-' + k)]);
  }
}

/** Leaflet's bindTooltip, as one shared popup over the named layers.
 *  Skipped on touch, where there is no hover and a popup only lands on top of
 *  the tap that was meant to select the ride. */
function hoverLabel(layers) {
  if (COARSE_POINTER) return;
  const pop = new maplibregl.Popup({
    closeButton: false, closeOnClick: false, offset: 12, className: 'map-pop',
  });
  layers.forEach(id => {
    map.on('mousemove', id, (e) => {
      if (draw.on) return;
      const f = e.features && e.features[0];
      if (!f || !f.properties || !f.properties.label) return;
      map.getCanvas().style.cursor = 'pointer';
      pop.setLngLat(e.lngLat).setText(f.properties.label).addTo(map);
    });
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = draw.on ? 'crosshair' : '';
      pop.remove();
    });
  });
}

/** Which rides are under the pointer, within the tap tolerance. */
function ridesAt(point) {
  if (!mapReady) return [];
  const t = HIT_TOLERANCE;
  return map.queryRenderedFeatures(
    [[point.x - t, point.y - t], [point.x + t, point.y + t]],
    { layers: ['lyr-rides'] });
}

/** The profile panel and the scrubber float over the map. Without this the
 *  fitted route runs underneath them. Returns what each is covering, in px. */
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

/** fitBounds that keeps the route clear of the floating panels.
 *  Animated by default now that the camera can afford it; callers that would
 *  rather not watch a flight (first paint, loading a shared link) opt out. */
function fitBoundsPadded(bounds, opts) {
  if (!bounds || !map || !mapReady) return;
  const p = mapPadding();
  map.fitBounds(bounds, {
    padding: { top: p.top, bottom: p.bottom, left: 16, right: 16 },
    maxZoom: 14,
    animate: !(opts && opts.animate === false),
    duration: 650,
    essential: true,
  });
}

function resizeMap() {
  if (!map) return;
  requestAnimationFrame(() => map.resize());
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

// The route as GeoJSON, with no map involved. The on-screen map and the video
// exporter both draw the same journey, so the features are built once here and
// each pushes them into its own sources.
function ridesFC() {
  const eps = state.settings.simplify;
  return fc(state.rides.map((ride, i) => lineFeature(
    simplify(ride.points, eps), {
      id: ride.id,
      // No halo here — that is the selection cue, drawn by highlightRide for
      // one ride at a time. On every ride at once it was just visual noise.
      color: shade(rideRGB(i, state.rides.length), LINE_DARKEN),
      label: `${ride.date.slice(0, 10)} — ${ride.name} (${fmtKm(ride.dist)} km)`,
    })));
}

function transfersFC() {
  return fc(state.transfers.map(t => {
    const st = MODES[t.mode] || MODES.other;
    return lineFeature(t.points, { mode: MODES[t.mode] ? t.mode : 'other',
                                   label: t.label || st.label });
  }));
}

function endsFC() {
  if (!state.rides.length) return EMPTY;
  const first = state.rides[0], last = state.rides[state.rides.length - 1];
  return fc([
    pointFeature(first.points[0], {
      color: '#8fbf6f', label: `Start — ${first.date.slice(0, 10)}` }),
    pointFeature(last.points[last.points.length - 1], {
      color: state.settings.brand, label: `Latest — ${last.date.slice(0, 10)}` }),
  ]);
}

function drawRides() {
  if (!mapReady) return;
  setData('src-rides', ridesFC());
  setData('src-ends', endsFC());
}

function drawTransfers() {
  if (!mapReady) return;
  setData('src-transfers', transfersFC());
}

function fitAll(opts) {
  const all = [];
  state.rides.forEach(r => all.push(r.points[0], r.points[r.points.length - 1]));
  state.transfers.forEach(t => { for (const p of t.points) all.push(p); });
  fitBoundsPadded(boundsOf(all), opts);
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
  if (!mapReady) return;
  draw.on = true;
  draw.pts = [];
  map.getCanvas().style.cursor = 'crosshair';
  map.doubleClickZoom.disable();
  renderDraw();
  $('#draw-hint').hidden = false;
  $('#btn-draw').textContent = 'Drawing… (Esc to cancel)';
}

function stopDrawing() {
  draw.on = false;
  draw.pts = [];
  if (map) {
    map.getCanvas().style.cursor = '';
    map.doubleClickZoom.enable();
    renderDraw();
  }
  $('#draw-hint').hidden = true;
  $('#btn-draw').textContent = 'Start drawing';
}

/** The vertices so far, plus a rubber band out to the cursor. */
function renderDraw(cursor) {
  if (!mapReady) return;
  if (!draw.on) { setData('src-draw', EMPTY); return; }
  const color = (MODES[drawMode] || MODES.other).color;
  const feats = draw.pts.map(p => pointFeature(p, { color }));
  const line = draw.pts.slice();
  if (cursor) line.push([cursor.lat, cursor.lng]);
  if (line.length > 1) feats.push(lineFeature(line, { color }));
  setData('src-draw', fc(feats));
}

/** Finish the line being drawn and keep it as a transfer.
 *
 *  A double-click fires two clicks of its own first, so the last vertex or two
 *  are the same point landed on twice. Dropping trailing near-duplicates is
 *  what stops every drawn line ending in a stutter. */
function finishDrawing() {
  const pts = draw.pts.slice();
  while (pts.length > 2) {
    const a = pts[pts.length - 1], b = pts[pts.length - 2];
    if (haversineKm(a, b) * 1000 > 25) break;   // 25 m apart is a real vertex
    pts.pop();
  }
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

/** Clicks, the rubber band and the finishing gestures, wired once at startup. */
function bindDrawing() {
  map.on('click', (e) => {
    if (!draw.on) return;
    draw.pts.push([e.lngLat.lat, e.lngLat.lng]);
    renderDraw(e.lngLat);
  });
  map.on('mousemove', (e) => { if (draw.on) renderDraw(e.lngLat); });
  map.on('dblclick', (e) => {
    if (!draw.on) return;
    e.preventDefault();
    finishDrawing();
  });
  document.addEventListener('keydown', (e) => {
    if (!draw.on) return;
    if (e.key === 'Enter') finishDrawing();
  });
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

  const pts = anim.path, breaks = anim.breaks;
  anim.cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    if (!breaks.has(i)) total += haversineKm(pts[i - 1], pts[i]);
    anim.cum.push(total);           // zero-length step: the dot teleports
  }
  anim.total = total;
  buildTrailLayers();
  $('#scrubber').hidden = pts.length < 2;
}

/** One GL line per continuous run, uploaded once.
 *
 *  The trail used to be rebuilt and re-projected every frame. Here the
 *  geometry is sent to the GPU once and the frame only moves where the line
 *  stops being drawn, via a line-gradient. Revealing it costs a paint-property
 *  change rather than a geometry upload, so frame cost no longer scales with
 *  how much of the journey is on screen.
 */
function buildTrailLayers() {
  if (!mapReady) return;
  anim.trailIds.forEach(id => {
    if (map.getLayer('lyr-' + id)) map.removeLayer('lyr-' + id);
    if (map.getSource('src-' + id)) map.removeSource('src-' + id);
  });
  anim.segs = trailSegments();
  anim.trailIds = anim.segs.map((_, i) => 'trail-' + i);
  addTrailLayers(map, anim.segs, 'lyr-ends');
}

/** The animated path cut at its run boundaries, with the distance each run
 *  spans. Pure — reads anim, touches no map, so the exporter can reuse it. */
function trailSegments() {
  const segs = [];
  const pts = anim.path;
  if (pts.length < 2) return segs;
  let start = 0;
  const flush = (end) => {
    if (end - start >= 2) segs.push({ i0: start, i1: end - 1 });
    start = end;
  };
  for (let i = 1; i < pts.length; i++) if (anim.breaks.has(i)) flush(i);
  flush(pts.length);
  segs.forEach(seg => { seg.d0 = anim.cum[seg.i0]; seg.d1 = anim.cum[seg.i1]; });
  return segs;
}

/** One GL line per run on `m`, uploaded once and revealed by gradient. */
function addTrailLayers(m, segs, before) {
  segs.forEach((seg, i) => {
    const id = 'trail-' + i;
    m.addSource('src-' + id, {
      type: 'geojson',
      lineMetrics: true,                 // required for line-gradient
      data: lineFeature(anim.path.slice(seg.i0, seg.i1 + 1), {}),
    });
    m.addLayer({
      id: 'lyr-' + id, type: 'line', source: 'src-' + id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': 4, 'line-opacity': 0 },
    }, before);
  });
}

/** Reveal the trail on `m` up to `done` km along the path. */
function paintTrail(m, segs, done, show) {
  segs.forEach((seg, i) => {
    const id = 'lyr-trail-' + i;
    if (!m.getLayer(id)) return;
    if (!show) { m.setPaintProperty(id, 'line-opacity', 0); return; }
    const span = seg.d1 - seg.d0;
    const f = span <= 0 ? (done >= seg.d1 ? 1 : 0)
                        : Math.min(1, Math.max(0, (done - seg.d0) / span));
    if (f <= 0) { m.setPaintProperty(id, 'line-opacity', 0); return; }
    m.setPaintProperty(id, 'line-opacity', .95);
    m.setPaintProperty(id, 'line-gradient', trailGradient(f, state.settings.brand));
  });
}

/** Solid up to `f` along the line, then nothing. Interpolation stops have to
 *  rise strictly, so f is held just inside both ends. */
function trailGradient(f, color) {
  if (!isFinite(f)) f = 0;        // Math.max(x, NaN) is NaN, and NaN stops
  if (f >= 1) {                   // make MapLibre reject the whole expression
    return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color];
  }
  const a = Math.min(.997, Math.max(.001, f));
  return ['interpolate', ['linear'], ['line-progress'],
          0, color, a, color,
          a + .001, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,0)'];
}

// ── Chapters ────────────────────────────────────────────────────────────────

/** Where along the animated path a coordinate sits, as a 0–1 fraction.
 *
 *  The path is the simplified, joined route, so a ride's own points are not in
 *  it verbatim — the nearest path point is the honest answer, and at 6000
 *  points a linear scan is well under a millisecond.
 */
function fractionOfPoint(pt, bias) {
  if (!anim.path || anim.path.length < 2 || !anim.total) return 0;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < anim.path.length; i++) {
    const p = anim.path[i];
    const dLat = p[0] - pt[0], dLon = p[1] - pt[1];
    const d = dLat * dLat + dLon * dLon;      // squared degrees is enough to rank
    if (d < bestD) { bestD = d; best = i; }
  }
  let d = anim.cum[best];

  // Run boundaries are deliberately zero-length, so the last point of one
  // ride and the first point of the next sit at the same distance along the
  // path. A plain fraction is therefore ambiguous there, and resolves to the
  // earlier of the two — which would open a chapter on the tail of the ride
  // before it. `bias` of +1 steps a hair into the new run to disambiguate;
  // chapter ends need no bias, since the earlier point is the right one.
  if (bias > 0 && best + 1 < anim.cum.length && anim.cum[best + 1] > d) {
    d += (anim.cum[best + 1] - d) * 1e-3;
  }
  return Math.min(1, Math.max(0, d / anim.total));
}

/** Rides a chapter covers, in journey order. */
function chapterRides(ch) {
  const ids = state.rides.map(r => r.id);
  let a = ids.indexOf(ch.fromRideId), b = ids.indexOf(ch.toRideId);
  if (a === -1) a = 0;
  if (b === -1) b = state.rides.length - 1;
  if (a > b) { const t = a; a = b; b = t; }
  return state.rides.slice(a, b + 1);
}

/** The stretch of route a chapter covers, as {t0, t1} fractions, plus its
 *  own distance, climbing and dates. Recomputed whenever rides change. */
function chapterSpan(ch) {
  const rides = chapterRides(ch);
  if (!rides.length) return null;
  const first = rides[0], last = rides[rides.length - 1];
  const t0 = fractionOfPoint(first.points[0], +1);
  const t1 = fractionOfPoint(last.points[last.points.length - 1]);
  const km = rides.reduce((s, r) => s + r.dist, 0);
  const ascent = rides.reduce((s, r) => s + (r.ascent || 0), 0);
  const secs = rides.reduce((s, r) => s + (r.duration || 0), 0);
  return {
    rides, km, ascent, secs,
    t0: Math.min(t0, t1), t1: Math.max(t0, t1),
    from: first.date.slice(0, 10), to: last.date.slice(0, 10),
  };
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
  if (!at || !mapReady) return;

  // A DOM marker is a CSS transform per frame, which beats re-tiling a
  // one-point GeoJSON source sixty times a second.
  if (!anim.dot) {
    const el = document.createElement('div');
    el.className = 'gl-dot';
    anim.dot = new maplibregl.Marker({ element: el }).setLngLat([0, 0]).addTo(map);
  }
  anim.dot.getElement().style.background = state.settings.brand;
  anim.dot.setLngLat([at.pos[1], at.pos[0]]);

  const done = anim.t * anim.total;
  paintTrail(map, anim.segs, done, $('#trail').value === 'draw');

  if ($('#follow').checked) map.jumpTo({ center: [at.pos[1], at.pos[0]] });

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
      // Distance, climbing and time were squeezing the name down to a letter
      // or two. They are all still on the map tooltip and in the ride's own
      // profile panel, which is where you look when you want them.
      `<span class="nm" title="${escapeHTML(r.name)} — ${r.date.slice(0, 10)}` +
      ` · ${fmtKm(r.dist)} km">${escapeHTML(r.name)}</span>` +
      `<span class="meta">${fmtShortDate(r.date)}</span>` +
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

function highlight(pts) {
  if (!mapReady || !pts || pts.length < 2) return;
  // Coarsened here rather than at the call sites: hovering a chapter hands
  // this every point of every ride it spans, and a hover cue does not need
  // a quarter of a million coordinates re-serialised to say "this bit".
  setData('src-hover',
    fc([lineFeature(simplify(pts, Math.max(state.settings.simplify, 25)), {})]));
}
function clearHighlight() { setData('src-hover', EMPTY); }

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function refreshAll() {
  drawRides();
  syncProfileButton();
  renderChapters();
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
    chapters: state.chapters,
  };
}

function load(data) {
  state.name = data.name || 'My Journey';
  state.rides = data.rides || [];
  state.transfers = data.transfers || [];
  state.chapters = data.chapters || [];
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
  refreshAll();
  if (state.rides.length) fitAll();
}

// ── Export ──────────────────────────────────────────────────────────────────
function download(name, text, type) {
  const blob = text instanceof Blob
    ? text
    : new Blob([text], { type: type || 'application/octet-stream' });
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
 .dot{width:16px;height:16px;border-radius:50%;border:2px solid #fff;
   background:${state.settings.brand};box-shadow:0 0 0 1px rgba(0,0,0,.35)}
 .maplibregl-popup-content{background:#17170f;color:#f0ebe3;border:1px solid #34342e;
   border-radius:7px;padding:5px 9px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.5)}
 .maplibregl-popup-tip{display:none}
</style></head><body>
<div id="map"></div>
<div id="title"><h1>${escapeHTML(state.name)}</h1><small id="sub"></small><small id="sub2"></small></div>
<div id="legend"></div>
<div id="bar"><button id="pp">▶</button><input id="pr" type="range" min="0" max="1000" value="0"><span id="lbl"></span></div>
<script src="https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js"><\/script>
<script>
const D=${JSON.stringify(payload)};
const MODES=${JSON.stringify(MODES)};
const TILES=${JSON.stringify(BASEMAPS)};
const BRAND=${JSON.stringify(state.settings.brand)};
const OSM=${JSON.stringify(OSM_ATTRIB)};
const bm=TILES[D.basemap]||TILES[Object.keys(TILES)[0]];
/* MapLibre draws the route as well as the basemap, so panning and zooming
   stay on the GPU no matter how long the journey is. */
const RASTER={version:8,sources:{osm:{type:'raster',tileSize:256,
 tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],attribution:OSM}},
 layers:[{id:'osm',type:'raster',source:'osm'}]};
function ln(p,props){const c=new Array(p.length);
 for(let i=0;i<p.length;i++)c[i]=[p[i][1],p[i][0]];
 return{type:'Feature',properties:props||{},geometry:{type:'LineString',coordinates:c}};}
function fc(f){return{type:'FeatureCollection',features:f};}

const path=[],brk=new Set();
D.runs.forEach(r=>{if(path.length)brk.add(path.length);r.forEach(p=>path.push(p));});
const cum=[0];let tot=0;
function hav(a,b){const R=6371,r=Math.PI/180,dla=(b[0]-a[0])*r,dlo=(b[1]-a[1])*r;
 const s=Math.sin(dla/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dlo/2)**2;
 return 2*R*Math.asin(Math.sqrt(s));}
/* zero-length across run boundaries: the dot jumps an undrawn gap */
for(let i=1;i<path.length;i++){if(!brk.has(i))tot+=hav(path[i-1],path[i]);cum.push(tot);}
function at(f){const g=f*tot;let lo=0,hi=cum.length-1;
 while(lo<hi){const m=(lo+hi)>>1;if(cum[m]<g)lo=m+1;else hi=m;}
 const i=Math.max(1,lo),seg=cum[i]-cum[i-1]||1e-9;
 const r=Math.min(1,Math.max(0,(g-cum[i-1])/seg)),a=path[i-1],b=path[i];
 return{pos:[a[0]+(b[0]-a[0])*r,a[1]+(b[1]-a[1])*r],idx:i};}

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

let t=0,playing=false,raf,last=0,render=function(){};
function step(ts){if(!playing)return;if(!last)last=ts;
 t+=((ts-last)/1000)/40;last=ts;if(t>=1){t=1;play(false);}render();
 if(playing)raf=requestAnimationFrame(step);}
function play(on){playing=on;last=0;document.getElementById('pp').textContent=on?'❚❚':'▶';
 if(on){if(t>=1)t=0;raf=requestAnimationFrame(step);}else if(raf)cancelAnimationFrame(raf);}
document.getElementById('pp').onclick=()=>play(!playing);
document.getElementById('pr').oninput=e=>{play(false);t=e.target.value/1000;render();};

fetch(bm.style).then(r=>r.json()).then(st=>{st.projection={type:'mercator'};return st;})
 .catch(()=>RASTER).then(style=>{
  const map=new maplibregl.Map({container:'map',style,center:[6,46],zoom:3.6,
    attributionControl:{compact:true},antialias:true,fadeDuration:150});
  map.addControl(new maplibregl.NavigationControl(),'top-left');
  map.touchZoomRotate.disableRotation();
  map.on('load',()=>build(map));
 });

function build(map){
 const all=[];
 map.addSource('rides',{type:'geojson',data:fc(D.rides.map(r=>{
   all.push(r.p[0],r.p[r.p.length-1]);
   return ln(r.p,{color:r.c,label:r.d+' — '+r.n+' ('+r.km+' km)'});}))});
 map.addLayer({id:'rides',type:'line',source:'rides',
   layout:{'line-cap':'round','line-join':'round'},
   paint:{'line-color':['get','color'],
     'line-width':['interpolate',['linear'],['zoom'],4,1.8,9,2.6,14,4]}});

 const used={};
 map.addSource('tr',{type:'geojson',data:fc(D.transfers.map(x=>{
   const m=MODES[x.m]?x.m:'other';used[m]=1;x.p.forEach(p=>all.push(p));
   return ln(x.p,{mode:m,label:x.l||MODES[m].label});}))});
 /* line-dasharray cannot be data-driven, so one layer per mode */
 Object.keys(MODES).forEach(k=>{const st=MODES[k];
   map.addLayer({id:'tr-'+k,type:'line',source:'tr',filter:['==',['get','mode'],k],
     layout:{'line-join':'round'},
     paint:{'line-color':st.color,'line-width':3,
       'line-dasharray':st.dash.split(',').map(n=>+n/3)}});});

 /* One GL line per continuous run, uploaded once. Revealing the trail is a
    gradient stop moving along it, not a geometry rebuild every frame. */
 const segs=[];
 (function(){let s0=0;const flush=end=>{if(end-s0>=2)segs.push({i0:s0,i1:end-1});s0=end;};
  for(let i=1;i<path.length;i++)if(brk.has(i))flush(i);flush(path.length);})();
 segs.forEach((g,i)=>{g.d0=cum[g.i0];g.d1=cum[g.i1];
  map.addSource('tseg'+i,{type:'geojson',lineMetrics:true,
    data:ln(path.slice(g.i0,g.i1+1),{})});
  map.addLayer({id:'tseg'+i,type:'line',source:'tseg'+i,
    layout:{'line-cap':'round','line-join':'round'},
    paint:{'line-width':4,'line-opacity':0}});});

 const el=document.createElement('div');el.className='dot';
 const dot=new maplibregl.Marker({element:el}).setLngLat([0,0]).addTo(map);

 function grad(f){if(f>=1)return['interpolate',['linear'],['line-progress'],0,BRAND,1,BRAND];
  const a=Math.min(.997,Math.max(.001,f));
  return['interpolate',['linear'],['line-progress'],0,BRAND,a,BRAND,
         a+.001,'rgba(0,0,0,0)',1,'rgba(0,0,0,0)'];}

 render=function(){if(path.length<2)return;const p=at(t),done=t*tot;
  dot.setLngLat([p.pos[1],p.pos[0]]);
  segs.forEach((g,i)=>{const id='tseg'+i,span=g.d1-g.d0;
   const f=span<=0?(done>=g.d1?1:0):Math.min(1,Math.max(0,(done-g.d0)/span));
   if(f<=0){map.setPaintProperty(id,'line-opacity',0);return;}
   map.setPaintProperty(id,'line-opacity',.95);
   map.setPaintProperty(id,'line-gradient',grad(f));});
  document.getElementById('pr').value=Math.round(t*1000);
  document.getElementById('lbl').textContent=
    Math.round(done).toLocaleString()+' / '+Math.round(tot).toLocaleString()+' km';};

 let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;
 all.forEach(p=>{if(p[1]<w)w=p[1];if(p[1]>e)e=p[1];if(p[0]<s)s=p[0];if(p[0]>n)n=p[0];});
 if(isFinite(w))map.fitBounds([[w,s],[e,n]],
   {padding:{top:92,bottom:84,left:30,right:30},animate:false,maxZoom:13});

 const lg=document.getElementById('legend');
 Object.keys(used).forEach(m=>{const st=MODES[m];
  lg.insertAdjacentHTML('beforeend','<div><i style="border-color:'+st.color+'"></i>'+st.label+'</div>');});
 if(!Object.keys(used).length)lg.style.display='none';

 const pop=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:12});
 ['rides'].concat(Object.keys(MODES).map(k=>'tr-'+k)).forEach(id=>{
  map.on('mousemove',id,ev=>{const f=ev.features&&ev.features[0];
   if(!f||!f.properties.label)return;
   map.getCanvas().style.cursor='pointer';
   pop.setLngLat(ev.lngLat).setText(f.properties.label).addTo(map);});
  map.on('mouseleave',id,()=>{map.getCanvas().style.cursor='';pop.remove();});});

 render();
}
<\/script></body></html>`;
}

function doExport(kind) {
  if (kind === 'publish-map')   { publish(false); return; }
  if (kind === 'publish-story') { publish(true); return; }
  if (kind === 'video')   { openVideoModal(); return; }
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
    const el = document.createElement('div');
    el.className = 'gl-cursor';
    profile.marker = new maplibregl.Marker({ element: el }).setLngLat([0, 0]).addTo(map);
  }
  profile.marker.getElement().style.background = state.settings.brand;
  profile.marker.setLngLat([s.pt[1], s.pt[0]]);
  $('#p-readout').textContent =
    `${fmtKm(s.km)} km · ${Math.round(s.ele).toLocaleString()} m`;
}

function clearProfileCursor() {
  const cur = $('#p-svg').querySelector('#p-cursor');
  if (cur) cur.setAttribute('opacity', '0');
  if (profile.marker) { profile.marker.remove(); profile.marker = null; }
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
  if (!mapReady) return;
  const i = state.rides.indexOf(ride);
  const rgb = rideRGB(i < 0 ? state.rides.length - 1 : i, state.rides.length);
  const pts = simplify(ride.points, state.settings.simplify);
  const a = pts[0], b = pts[pts.length - 1];

  // One source feeds both the glow and the white line over it.
  setData('src-sel', fc([lineFeature(pts, { color: rgba(rgb, SELECT_HALO_ALPHA) })]));
  setData('src-sel-caps', fc([
    pointFeature(a, { color: '#8fbf6f', label: `Start — ${ride.date.slice(0, 10)}` }),
    pointFeature(b, { color: shade(rgb, 1.15), label: `End — ${fmtKm(ride.dist)} km` }),
  ]));
  rideHighlight = true;
}

function fitToRide(ride) {
  fitBoundsPadded(boundsOf(simplify(ride.points, state.settings.simplify)));
}

function clearRideHighlight() {
  if (!rideHighlight) return;
  setData('src-sel', EMPTY);
  setData('src-sel-caps', EMPTY);
  rideHighlight = null;
}


// ── Story: authoring ────────────────────────────────────────────────────────

let editingChapter = null;      // the chapter being edited, or null for a new one

function renderChapters() {
  const ul = $('#chapter-list');
  ul.innerHTML = '';
  state.chapters.forEach((ch, i) => {
    const span = chapterSpan(ch);
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="nm" title="${escapeHTML(ch.title || 'Untitled')}">` +
      `${escapeHTML(ch.title || 'Untitled')}</span>` +
      `<span class="meta">${span ? `${span.rides.length} rides` : '—'}</span>` +
      `<button class="del" title="Edit">✎</button>`;
    li.querySelector('.del').onclick = () => openChapterEditor(ch);
    li.onmouseenter = () => { if (span) highlight(span.rides.flatMap(r => r.points)); };
    li.onmouseleave = clearHighlight;
    ul.appendChild(li);
  });

  const n = state.chapters.length;
  $('#chapters-count').textContent = n ? `${n} chapter${n === 1 ? '' : 's'}` : 'No chapters yet';
  $('#btn-tell-story').disabled = n === 0;
  $('#story-hint').textContent = n
    ? 'Scroll through it, or publish and the link opens straight into the story.'
    : 'Add a chapter to turn the journey into a scrolling story.';
}

function rideOptions(selected) {
  return state.rides.map(r =>
    `<option value="${escapeHTML(r.id)}"${r.id === selected ? ' selected' : ''}>` +
    `${escapeHTML(fmtShortDate(r.date))} — ${escapeHTML(r.name)}</option>`).join('');
}

function openChapterEditor(ch) {
  if (!state.rides.length) { toast('Add some rides first', true); return; }
  editingChapter = ch || null;

  const first = state.rides[0], last = state.rides[state.rides.length - 1];
  $('#chapter-modal-title').textContent = ch ? 'Edit chapter' : 'New chapter';
  $('#ch-title').value = ch ? (ch.title || '') : '';
  $('#ch-text').value = ch ? (ch.text || '') : '';
  $('#ch-from').innerHTML = rideOptions(ch ? ch.fromRideId : first.id);
  $('#ch-to').innerHTML = rideOptions(ch ? ch.toRideId : last.id);
  $('#ch-delete').hidden = !ch;

  renderPhotoRows(ch ? (ch.photos || []) : []);
  updateChapterSpanNote();
  $('#chapter-modal').hidden = false;
  $('#ch-title').focus();
}

function renderPhotoRows(photos) {
  const ul = $('#ch-photos');
  ul.innerHTML = '';
  photos.forEach(p => addPhotoRow(p.url, p.caption));
}

function addPhotoRow(url, caption) {
  const li = document.createElement('li');
  li.className = 'photo-row';
  li.innerHTML =
    `<img class="p-thumb" alt="">` +
    `<div class="p-fields">` +
      `<input class="p-url" type="url" placeholder="https://…/photo.jpg" value="${escapeHTML(url || '')}">` +
      `<input class="p-cap" type="text" placeholder="caption" value="${escapeHTML(caption || '')}">` +
      `<span class="p-state"></span>` +
    `</div>` +
    `<button class="del" title="Remove">✕</button>`;
  li.querySelector('.del').onclick = () => li.remove();

  // Load the URL as soon as it is pasted and say what happened. A broken
  // link is otherwise completely invisible: an <img> that fails to load
  // collapses to nothing, so the row looks saved and the story looks empty.
  const input = li.querySelector('.p-url');
  const thumb = li.querySelector('.p-thumb');
  const note  = li.querySelector('.p-state');
  let timer = null;
  const probe = () => probePhoto(input.value, thumb, note);
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(probe, 450);      // let a paste or typing settle first
  });
  input.addEventListener('change', probe);

  $('#ch-photos').appendChild(li);
  if (url) probe();
}

const BLANK_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Point a thumbnail at a URL and report the outcome next to it.
 * Asking the browser to load it is the only reliable test: file extensions
 * lie, plenty of hosts serve images from extensionless paths, and some
 * refuse to serve them to another site at all.
 */
function probePhoto(raw, thumb, note) {
  const u = String(raw || '').trim();
  thumb.classList.remove('ok', 'bad');
  note.classList.remove('bad');
  thumb.removeAttribute('src');        // forces a fresh load for the same URL

  if (!u) { note.textContent = ''; return; }

  note.textContent = 'Loading…';
  thumb.onload = () => {
    thumb.classList.add('ok');
    note.textContent = `${thumb.naturalWidth} × ${thumb.naturalHeight}`;
  };
  thumb.onerror = () => {
    // Swap in a blank pixel rather than clearing src: an <img> left in its
    // failed state paints the browser's broken-image glyph, which reads as
    // a bug in the app instead of as a bad link.
    thumb.onload = thumb.onerror = null;
    thumb.src = BLANK_PIXEL;
    thumb.classList.add('bad');
    note.classList.add('bad');
    note.textContent = 'Didn’t load — needs a direct link to the image file itself';
  };
  thumb.src = u;
}

function collectPhotoRows() {
  return Array.from($('#ch-photos').querySelectorAll('li')).map(li => ({
    url: li.querySelector('.p-url').value.trim(),
    caption: li.querySelector('.p-cap').value.trim(),
  })).filter(p => p.url);
}

/** Live summary of what the chosen ride range covers. */
function updateChapterSpanNote() {
  const probe = { fromRideId: $('#ch-from').value, toRideId: $('#ch-to').value };
  const span = chapterSpan(probe);
  const el = $('#ch-span');
  if (!span) { el.textContent = ''; return; }
  const bits = [`${span.rides.length} ride${span.rides.length === 1 ? '' : 's'}`,
                `${fmtKm(span.km)} km`];
  if (span.ascent > 0) bits.push(`${Math.round(span.ascent).toLocaleString()} m climbed`);
  el.innerHTML = `<b>${span.from}</b> to <b>${span.to}</b> &middot; ${bits.join(' · ')}`;
}

function saveChapter() {
  const data = {
    id: editingChapter ? editingChapter.id : uid(),
    title: $('#ch-title').value.trim() || 'Untitled',
    text: $('#ch-text').value,
    fromRideId: $('#ch-from').value,
    toRideId: $('#ch-to').value,
    photos: collectPhotoRows(),
  };
  if (editingChapter) {
    Object.assign(editingChapter, data);
  } else {
    state.chapters.push(data);
  }
  // Keep chapters in journey order so the story reads forwards.
  const order = state.rides.map(r => r.id);
  state.chapters.sort((a, b) => order.indexOf(a.fromRideId) - order.indexOf(b.fromRideId));

  $('#chapter-modal').hidden = true;
  editingChapter = null;
  renderChapters();
  persist();
}

// ── Story: reading ──────────────────────────────────────────────────────────

const story = { spans: [], cards: [], active: -1, raf: null };

function openStory() {
  if (!state.chapters.length) { toast('Add a chapter first', true); return; }
  prepareAnim();
  story.spans = state.chapters.map(chapterSpan);

  const wrap = $('#story-scroll');
  wrap.innerHTML = state.chapters.map((ch, i) => {
    const sp = story.spans[i];
    const meta = sp
      ? [`${sp.from} – ${sp.to}`, `${fmtKm(sp.km)} km`]
          .concat(sp.ascent > 0 ? [`${Math.round(sp.ascent).toLocaleString()} m`] : [])
          .join('  ·  ')
      : '';
    const photos = (ch.photos || []).map(p =>
      `<figure><img src="${escapeHTML(p.url)}" alt="${escapeHTML(p.caption || '')}" loading="lazy">` +
      (p.caption ? `<figcaption>${escapeHTML(p.caption)}</figcaption>` : '') + `</figure>`).join('');
    return `<article class="chapter-card" data-i="${i}"><div class="ch-inner">` +
           `<h2>${escapeHTML(ch.title)}</h2>` +
           `<div class="ch-meta">${escapeHTML(meta)}</div>` +
           (ch.text ? `<p>${escapeHTML(ch.text)}</p>` : '') +
           photos + `</div></article>`;
  }).join('') +
  `<div class="story-end"><span>End of the journey — ${escapeHTML(state.name)}</span></div>`;

  story.cards = Array.from(wrap.querySelectorAll('.chapter-card'));

  // A photo whose URL has stopped resolving would otherwise leave a silent
  // gap in the story. Show what was meant to be there instead.
  wrap.querySelectorAll('.chapter-card img').forEach(im => {
    im.addEventListener('error', () => {
      const fig = im.closest('figure');
      if (!fig) return;
      fig.classList.add('broken');
      const box = document.createElement('div');
      box.className = 'broken-photo';
      box.innerHTML = `<b>Photo didn’t load</b>` +
        `<span>${escapeHTML(im.getAttribute('src') || '')}</span>`;
      im.replaceWith(box);
    });
  });

  story.active = -1;

  document.body.classList.add('story');
  $('#story').hidden = false;
  lockMap(true);
  syncStoryLine();
  resizeMap();
  wrap.scrollTop = 0;
  wrap.addEventListener('scroll', onStoryScroll, { passive: true });
  // resizeMap defers to the next frame, and the first chapter is framed
  // against the canvas size, so wait for that to land before measuring.
  requestAnimationFrame(() => requestAnimationFrame(onStoryScroll));
}

function closeStory() {
  const wrap = $('#story-scroll');
  wrap.removeEventListener('scroll', onStoryScroll);
  document.body.classList.remove('story');
  $('#story').hidden = true;
  story.cards = [];
  lockMap(false);
  resizeMap();
  if (state.rides.length) fitAll();
}

/** Scroll position drives the animation.
 *
 *  The card crossing a line a third of the way down the column is the one
 *  being read; how far it has crossed is how far through its stretch of route
 *  we are. That maps straight onto the existing animation fraction, so the
 *  dot and the drawn trail are the same code the play button uses.
 */
function onStoryScroll() {
  if (story.raf) return;                 // coalesce to one update per frame
  story.raf = requestAnimationFrame(() => {
    story.raf = null;
    const wrap = $('#story-scroll');
    if (!story.cards.length) return;

    const stop = storyStops(wrap);
    const y = wrap.scrollTop;
    let idx = 0;
    for (let i = 0; i < stop.starts.length; i++) if (y >= stop.starts[i]) idx = i;
    const span = story.spans[idx];
    const a = stop.starts[idx], b = stop.ends[idx];
    const progress = b > a ? Math.min(1, Math.max(0, (y - a) / (b - a))) : 1;

    if (idx !== story.active) {
      story.cards.forEach((c, i) => c.classList.toggle('live', i === idx));
      story.active = idx;
      // The camera moves once per chapter, not once per frame. Framing the
      // chapter's own extent is what puts the reader at the scale of the
      // section being described, and because the whole of it is in view the
      // dot never needs chasing — the sense of movement comes from the trail
      // drawing itself, over a camera that holds still enough to read against.
      frameChapter(idx);
    }
    if (!span) return;

    anim.t = span.t0 + (span.t1 - span.t0) * progress;
    renderAnim();
  });
}

/** The scroll range each chapter owns.
 *
 *  A chapter has to begin with the dot at the first point of its "from" ride
 *  and end with it at the last point of its "to" ride, so its range runs from
 *  the scroll position where it takes over to the one where the next chapter
 *  does — the last running to the bottom of the scroll.
 *
 *  Deriving progress from the trigger line instead got both ends wrong. The
 *  line sits part-way down the viewport, so at the very top of the scroll it
 *  was already past the first card's start and chapter one opened a third of
 *  the way through; and the scroll ran out before the line could reach the
 *  end of the last card, so the final chapter never finished. The lead-in and
 *  tail spacers below exist to make every chapter's range the same length.
 */
function storyStops(wrap) {
  const lead = wrap.clientHeight * storyLine();
  const max = Math.max(1, wrap.scrollHeight - wrap.clientHeight);
  const starts = story.cards.map(c =>
    Math.min(max, Math.max(0, c.offsetTop - lead)));
  const ends = starts.map((v, i) => i + 1 < starts.length ? starts[i + 1] : max);
  return { starts, ends };
}

/** Where down the screen a chapter becomes the live one.
 *
 *  The card is pinned at exactly this height (CSS reads it back as
 *  --story-line), and the two have to agree. A card pinned anywhere else
 *  slides out of view part-way through its own chapter: its sticky box is
 *  only pinned while its parent still covers the offset, and the parent only
 *  covers it for the whole chapter when offset and trigger line coincide.
 *  Low on a phone: padding can only exclude a rectangle, so everything below
 *  the card's top edge is lost to the framing whether the card covers it or
 *  not. The nearer the card sits to the bottom, the more map is left.
 */
function storyLine() { return window.innerWidth <= 760 ? .58 : .30; }

function syncStoryLine() {
  const wrap = $('#story-scroll');
  if (!wrap) return;
  const h = wrap.clientHeight;
  // Lead-in: without it the first card starts above the line it pins at, so
  // it is neither pinned nor at the beginning of its own range.
  wrap.style.setProperty('--story-line', Math.round(h * storyLine()) + 'px');
  // Tail: enough scroll left under the last card for its range to match the
  // others', rather than the dot racing through the final chapter.
  wrap.style.setProperty('--story-tail', Math.round(h * (1 - storyLine())) + 'px');
}

/** How much of the map the narrative card is sitting on top of.
 *
 *  Measured from the live card rather than assumed, because the column is a
 *  left-hand strip on a wide screen and a bottom slab on a phone. Clamped
 *  well inside the canvas: padding larger than the viewport makes fitBounds
 *  pick nonsense.
 */
function storyPadding() {
  const pad = { top: 28, bottom: 28, left: 28, right: 28 };
  const inner = $('#story-scroll .chapter-card.live .ch-inner') ||
                $('#story-scroll .ch-inner');
  if (!map || !inner) return pad;
  const box = inner.getBoundingClientRect();
  const canvas = map.getCanvas().getBoundingClientRect();
  const clamp = (v, max) => Math.max(28, Math.min(v, max * .62));
  if (window.innerWidth <= 760) {
    pad.bottom = clamp(canvas.bottom - box.top + 20, canvas.height);
  } else {
    pad.left = clamp(box.right - canvas.left + 20, canvas.width);
  }
  return pad;
}

/** Fly to the stretch of route one chapter covers. */
function frameChapter(i) {
  if (!mapReady) return;
  const sp = story.spans[i];
  if (!sp || !sp.rides.length) return;
  const eps = Math.max(state.settings.simplify, 25);
  const pts = [];
  sp.rides.forEach(r => {
    const simp = simplify(r.points, eps);
    for (let k = 0; k < simp.length; k++) pts.push(simp[k]);
  });
  const b = boundsOf(pts);
  if (!b) return;
  map.fitBounds(b, {
    padding: storyPadding(),
    maxZoom: 14,              // a short chapter gets real detail
    duration: 1100,
    essential: true,
  });
}

// Everything that would otherwise let a reader move the map themselves.
const MAP_HANDLERS = ['dragPan', 'scrollZoom', 'boxZoom', 'dragRotate',
                      'keyboard', 'doubleClickZoom', 'touchZoomRotate', 'touchPitch'];

/** In story mode the scroll position *is* the camera, so nothing else may
 *  drive it. The scroll layer already covers the map and swallows pointer
 *  events; this also closes the keyboard and trackpad routes into it. */
function lockMap(locked) {
  if (!map) return;
  MAP_HANDLERS.forEach(name => {
    const h = map[name];
    if (!h) return;
    if (locked) h.disable(); else h.enable();
  });
  // enable() on touchZoomRotate brings rotation back with it.
  if (!locked && map.touchZoomRotate) map.touchZoomRotate.disableRotation();
}

// ── Video export ────────────────────────────────────────────────────────────
// Frames are rendered one at a time into an offscreen map, not screen-recorded.
// captureStream + MediaRecorder would be real time, would bake in every
// half-loaded tile the camera flew through, and would capture only the map
// canvas — the overlays and the dot are not on it. Rendering frame by frame
// means waiting for `idle` before reading each one, so every frame is complete
// whatever the network did, and the clip takes as long as it takes.
//
// This is feasible only because the animation is a pure function of anim.t:
// there is no clock to outrun, so any frame can be produced on demand.

const VIDEO_PRESETS = {
  reel:      { label: 'Reel / Story — 1080 × 1920', w: 1080, h: 1920 },
  landscape: { label: 'Landscape — 1920 × 1080',    w: 1920, h: 1080 },
  square:    { label: 'Square — 1080 × 1080',       w: 1080, h: 1080 },
};

const MUXER_URL = 'https://unpkg.com/mp4-muxer@5.2.2/build/mp4-muxer.js';

const video = { running: false, cancel: false };

function loadScriptOnce(url) {
  loadScriptOnce.seen = loadScriptOnce.seen || {};
  if (!loadScriptOnce.seen[url]) {
    loadScriptOnce.seen[url] = new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = url;
      el.onload = () => res();
      el.onerror = () => { delete loadScriptOnce.seen[url]; rej(new Error('could not load ' + url)); };
      document.head.appendChild(el);
    });
  }
  return loadScriptOnce.seen[url];
}

/** Null if this browser can encode video, otherwise why not. */
function videoBlocker() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return 'This browser cannot encode video. Chrome, Edge, Safari 16.4+ or ' +
           'Firefox 130+ support the WebCodecs encoder this needs.';
  }
  return null;
}

/** First H.264 profile the browser will actually encode at this size.
 *  High, then Main, then Baseline — hardware support varies by machine, and
 *  a configure() on an unsupported profile throws rather than degrading. */
async function pickVideoConfig(w, h, fps) {
  const bitrate = Math.min(28e6, Math.round(w * h * fps * 0.11));
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42001f']) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: fps };
    try {
      const probe = await VideoEncoder.isConfigSupported(cfg);
      if (probe && probe.supported) return cfg;
    } catch (e) { /* try the next profile */ }
  }
  return null;
}

/** Resolve once `m` has finished drawing, or once we have waited long enough.
 *  Without this the frame is read mid tile-load and the video shows the gaps. */
function mapIdle(m, ms) {
  return new Promise(res => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      m.off('idle', done);
      clearTimeout(timer);
      res();
    };
    const timer = setTimeout(done, ms || 2500);
    m.on('idle', done);
  });
}

/** A map sized to the output, off screen, carrying the same journey. */
async function makeExportMap(w, h, segs) {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-20000px;top:0;pointer-events:none;' +
    'width:' + w + 'px;height:' + h + 'px;';
  document.body.appendChild(host);

  const bm = BASEMAPS[state.settings.basemap] || BASEMAPS[Object.keys(BASEMAPS)[0]];
  const m = new maplibregl.Map({
    container: host,
    style: await loadStyle(bm),
    center: [6, 46], zoom: 4,
    interactive: false,
    attributionControl: false,   // redrawn into the frame instead, see credit()
    preserveDrawingBuffer: true, // required to read the canvas back
    pixelRatio: 1,               // the container is already at output size
    fadeDuration: 0,             // no label caught half faded-in in a still
  });

  await new Promise(res => m.once('load', res));
  addMapLayers(m);
  setData('src-rides', ridesFC(), m);
  setData('src-transfers', transfersFC(), m);
  setData('src-ends', endsFC(), m);
  addTrailLayers(m, segs, 'lyr-ends');
  return { map: m, host };
}

/** Basemap credit as plain text. It is a licence condition, so it is drawn
 *  into every frame rather than offered as something to switch off. */
function creditText() {
  const bm = BASEMAPS[state.settings.basemap] || BASEMAPS[Object.keys(BASEMAPS)[0]];
  return String(bm.attribution || OSM_ATTRIB)
    .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function drawCredit(ctx, w, h, text) {
  const pad = Math.round(Math.min(w, h) * 0.014);
  ctx.font = Math.round(Math.min(w, h) * 0.018) + 'px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const tw = ctx.measureText(text).width;
  const fh = Math.round(Math.min(w, h) * 0.018);
  ctx.fillStyle = 'rgba(12,12,9,.55)';
  ctx.fillRect(w - tw - pad * 2.2, h - fh - pad * 1.9, tw + pad * 1.6, fh + pad * 1.2);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillText(text, w - pad * 1.4, h - pad * 1.2);
}

function drawDot(ctx, m, pos, w, h) {
  const p = m.project([pos[1], pos[0]]);
  const r = Math.max(6, Math.round(Math.min(w, h) * 0.011));
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = state.settings.brand;
  ctx.fill();
  ctx.lineWidth = Math.max(2, Math.round(r * 0.34));
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

// ── Video export: the dialog ────────────────────────────────────────────────

function openVideoModal() {
  const sel = $('#vid-preset');
  if (!sel.options.length) {
    sel.innerHTML = Object.entries(VIDEO_PRESETS)
      .map(([k, v]) => `<option value="${k}">${escapeHTML(v.label)}</option>`).join('');
  }
  prepareAnim();

  const note = $('#vid-note');
  const blocked = videoBlocker();
  if (blocked) {
    note.innerHTML = `<span class="warn">${escapeHTML(blocked)}</span>`;
  } else if (anim.path.length < 2) {
    note.innerHTML = '<span class="warn">Add some rides first — there is no ' +
                     'route to animate yet.</span>';
  } else {
    note.textContent = '';
  }
  $('#vid-go').disabled = !!blocked || anim.path.length < 2;

  $('#vid-progress').hidden = true;
  $('#vid-bar').style.width = '0%';
  $('#vid-status').textContent = '';
  $('#vid-cancel').textContent = 'Cancel';
  $('#video-modal').hidden = false;
  estimateVideo();
}

function fmtClock(secs) {
  secs = Math.max(0, Math.round(secs));
  const m = Math.floor(secs / 60), s = secs % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** Say up front how long this will take. A clip of any length is minutes of
 *  rendering, and the per-frame cost is dominated by waiting for tiles, not
 *  by encoding — measured at 0.12 s a frame warm, 0.4 s cold. */
function estimateVideo() {
  if ($('#vid-go').disabled) return;
  const fps = +$('#vid-fps').value;
  const secs = Math.max(2, Math.min(120, +$('#vid-secs').value || 15));
  const frames = Math.round(secs * fps);
  $('#vid-note').innerHTML =
    `${frames.toLocaleString()} frames, so roughly ` +
    `<b>${fmtClock(frames * 0.12)}–${fmtClock(frames * 0.4)}</b> to render. ` +
    `Leave this tab in front — browsers throttle background tabs and the ` +
    `render stalls.`;
}

async function runVideoExport() {
  const opts = {
    preset: $('#vid-preset').value,
    fps: +$('#vid-fps').value,
    seconds: Math.max(2, Math.min(120, +$('#vid-secs').value || 15)),
    zoom: parseFloat($('#vid-zoom').value),
  };

  video.running = true;
  video.cancel = false;
  $('#vid-go').disabled = true;
  $('#vid-cancel').textContent = 'Stop';
  $('#vid-progress').hidden = false;
  $('#vid-note').textContent = '';

  const started = Date.now();
  const onProgress = (done, total) => {
    $('#vid-bar').style.width = (done / total * 100).toFixed(1) + '%';
    const per = (Date.now() - started) / done;
    const left = Math.round((total - done) * per / 1000);
    $('#vid-status').textContent =
      `${done}/${total}` + (done > 4 ? ` · ${fmtDuration(left)} left` : '');
  };

  try {
    const blob = await exportVideo(opts, onProgress);
    if (!blob) { toast('Export stopped'); return; }
    const safe = state.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'journey';
    download(safe + '-animation.mp4', blob, 'video/mp4');
    $('#video-modal').hidden = true;
    toast(`Saved ${(blob.size / 1e6).toFixed(1)} MB of MP4`);
  } catch (e) {
    $('#vid-note').innerHTML = `<span class="warn">${escapeHTML(e.message || String(e))}</span>`;
  } finally {
    video.running = false;
    video.cancel = false;
    $('#vid-go').disabled = false;
    $('#vid-cancel').textContent = 'Cancel';
    $('#vid-progress').hidden = true;
  }
}

/** Render the animation to an MP4 and hand it over as a download. */
async function exportVideo(opts, onProgress) {
  const blocked = videoBlocker();
  if (blocked) throw new Error(blocked);
  if (anim.path.length < 2) throw new Error('nothing to animate yet');

  const preset = VIDEO_PRESETS[opts.preset] || VIDEO_PRESETS.reel;
  const w = preset.w, h = preset.h, fps = opts.fps;
  const frames = Math.max(2, Math.round(opts.seconds * fps));

  const cfg = await pickVideoConfig(w, h, fps);
  if (!cfg) throw new Error('this browser will not encode H.264 at ' + w + '×' + h);

  await loadScriptOnce(MUXER_URL);
  if (typeof Mp4Muxer === 'undefined') throw new Error('the MP4 muxer did not load');

  const segs = trailSegments();
  const made = await makeExportMap(w, h, segs);
  const m = made.map;

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { alpha: false });
  const credit = creditText();

  // No zoom given means "show the whole thing": fit the route at the output's
  // own aspect ratio, which is not the one on screen.
  let zoom = opts.zoom;
  if (!(zoom > 0)) {
    const b = boundsOf(anim.path);
    const cam = b && m.cameraForBounds(b, { padding: Math.round(Math.min(w, h) * 0.08) });
    zoom = cam ? cam.zoom : 6;
  }

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    fastStart: 'in-memory',
  });
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encodeError = e; },
  });
  encoder.configure(cfg);

  const t0 = 0, t1 = 1;
  try {
    for (let f = 0; f < frames; f++) {
      if (video.cancel) break;
      if (encodeError) throw encodeError;

      const t = t0 + (t1 - t0) * (f / (frames - 1));
      const at = atFraction(t);
      if (!at) break;

      m.jumpTo({ center: [at.pos[1], at.pos[0]], zoom });
      paintTrail(m, segs, t * anim.total, true);
      await mapIdle(m);

      ctx.drawImage(m.getCanvas(), 0, 0, w, h);
      drawDot(ctx, m, at.pos, w, h);
      drawCredit(ctx, w, h, credit);

      const frame = new VideoFrame(cv, {
        timestamp: Math.round(f * 1e6 / fps),
        duration: Math.round(1e6 / fps),
      });
      // A keyframe every couple of seconds keeps the file seekable.
      encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();

      // Never let the encoder fall far behind: each queued frame is a full
      // uncompressed 1080p surface, and a few hundred of them is gigabytes.
      while (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 4));
      if (onProgress) onProgress(f + 1, frames);
    }

    if (video.cancel) { encoder.close(); return null; }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    try { if (encoder.state !== 'closed') encoder.close(); } catch (e) {}
    m.remove();
    made.host.remove();
  }
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
/** `withStory` decides which of the two share links this is. The viewer
 *  opens into the story when chapters arrive and shows the bare animated map
 *  when they do not, so leaving them out is the whole difference — and it
 *  means a map link cannot leak writing that was meant for a different
 *  audience. */
function publishPayload(simplifyM, withStory) {
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
    chapters: withStory ? state.chapters : [],
  };
}

async function publish(withStory) {
  if (!state.rides.length) { toast('Add some rides first', true); return; }
  if (withStory && !state.chapters.length) {
    toast('No chapters yet — write some in the Story tab first', true);
    return;
  }
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
      payload = publishPayload(eps, withStory);
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
    showShareLink(id, b64.length, withStory);
  } catch (e) {
    status('');
    toast('Could not publish: ' + e.message, true);
  }
}

function shareUrlFor(id) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return `${base}?p=${id}`;
}

function showShareLink(id, bytes, withStory) {
  const url = shareUrlFor(id);
  $('#share-url').value = url;
  $('#share-title').textContent = withStory ? 'Story published' : 'Map published';
  $('#share-note').textContent =
    (withStory
      ? `This link opens straight into the story, ${state.chapters.length} ` +
        `chapter${state.chapters.length === 1 ? '' : 's'} of it; closing the ` +
        `story leaves the map behind. `
      : `This link opens the animated map on its own. Your chapters are not ` +
        `in it — publish the story separately to share those. `) +
    `It cannot be edited once published, and it is not listed anywhere — ` +
    `the link is the only way in. (${(bytes / 1024).toFixed(0)} KB)`;
  $('#share-modal').hidden = false;
  $('#share-url').select();
}

/** Load a published map into the viewer. */
async function openPublished(id) {
  document.body.classList.add('viewing');
  // The map was sized with the panel and topbar on screen. Hiding them does
  // not tell MapLibre anything, so without this it keeps painting at the old
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
    state.chapters = data.chapters || [];
    Object.assign(state.settings, data.settings || {});

    refreshAll();
    fitAll({ animate: false });     // a shared link should open already framed

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

    // A journey with chapters was written to be read, so open into the story
    // rather than a bare map. Closing it leaves the normal viewer behind.
    if (state.chapters.length) openStory();
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
  $('#btn-draw').onclick = () => draw.on ? stopDrawing() : startDrawing();
  bindDrawing();
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

  // Story
  $('#btn-add-chapter').onclick = () => openChapterEditor(null);
  $('#ch-save').onclick = saveChapter;
  $('#ch-cancel').onclick = () => { $('#chapter-modal').hidden = true; editingChapter = null; };
  $('#ch-delete').onclick = () => {
    if (!editingChapter) return;
    if (!confirm(`Delete "${editingChapter.title || 'Untitled'}"?`)) return;
    state.chapters = state.chapters.filter(c => c !== editingChapter);
    $('#chapter-modal').hidden = true;
    editingChapter = null;
    renderChapters(); persist();
  };
  $('#ch-add-photo').onclick = () => addPhotoRow('', '');
  $('#ch-from').onchange = updateChapterSpanNote;
  $('#ch-to').onchange = updateChapterSpanNote;
  $('#chapter-modal').addEventListener('click', e => {
    if (e.target.id === 'chapter-modal') { $('#chapter-modal').hidden = true; editingChapter = null; }
  });
  $('#btn-clear-chapters').onclick = () => {
    if (!state.chapters.length) return;
    if (!confirm(`Remove all ${state.chapters.length} chapters? Rides are kept.`)) return;
    state.chapters = []; renderChapters(); persist();
  };
  $('#btn-tell-story').onclick = openStory;
  $('#story-exit').onclick = closeStory;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#story').hidden) closeStory();
  });

  // One handler for both selecting a ride and dropping the selection. The
  // hit box around the pointer is what makes a near-miss on a phone land on
  // the line, so no separate touch fudge is needed any more.
  map.on('click', (e) => {
    if (draw.on) return;
    const hit = ridesAt(e.point)[0];
    if (hit) {
      const ride = state.rides.find(r => r.id === hit.properties.id);
      if (ride) { showRideProfile(ride); return; }
    }
    if (profile.ride) showJourneyProfile();
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
    // The pinning offset is a pixel value derived from the viewport height,
    // and the breakpoint moves it, so it has to be recomputed on a rotate.
    syncStoryLine();
    if (!$('#story').hidden) onStoryScroll();
    // Axis ticks are laid out in pixels, so the plot has to be redrawn.
    clearTimeout(profileRedraw);
    profileRedraw = setTimeout(() => { if (!$('#profile').hidden) renderProfile(); }, 120);
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  // Video export
  $('#vid-go').onclick = () => { if (!video.running) runVideoExport(); };
  $('#vid-cancel').onclick = () => {
    if (video.running) { video.cancel = true; $('#vid-status').textContent = 'stopping…'; }
    else $('#video-modal').hidden = true;
  };
  ['#vid-secs', '#vid-fps'].forEach(sel => {
    $(sel).addEventListener('input', estimateVideo);
    $(sel).addEventListener('change', estimateVideo);
  });

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
  // Resolves once the map object exists, not once it has drawn: wire() needs
  // something to bind handlers to, but nothing else should wait on a frame.
  await initMap();
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
  if (state.rides.length) fitAll({ animate: false });
})();
