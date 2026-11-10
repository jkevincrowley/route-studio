# Route Studio

Turn a pile of recorded rides into one continuous journey — draw the ferries,
trains and buses that link them, then animate a dot along the whole thing.

**Everything runs in your browser.** No account, no server, no upload. Your
rides stay on your machine.


---

## Why this exists

GPX mergers will happily concatenate your files, but they leave a straight line
across the sea where you took the overnight ferry. Relive animates one ride at a
time, not a season. Polarsteps tells a travel story but [won't import GPX at
all](https://support.polarsteps.com/hc/en-us/articles/24267546737426-Can-I-import-a-GPX-or-other-location-file-into-Polarsteps).

Route Studio fills the gap in between: many recorded rides, the non-cycling legs
drawn in by hand and labelled by mode, joined into one line you can animate,
export, or publish.

---

## Make it your own

Route Studio is eight static files with no server behind it, so a copy is
genuinely yours — your rides never leave your machine, and nothing runs on
anyone else's account.

**No terminal, no coding. Four steps:**

1. On this page, click the green **Use this template → Create a new repository**.
   Give it a name and click **Create repository**.
2. In your new repo: **Settings → Pages**, and under **Source** choose
   **GitHub Actions**.
3. Open the **Actions** tab. If it offers, click **I understand my workflows,
   go ahead and enable them**, then let the first build finish.
4. Your copy is live at `https://<your-username>.github.io/<your-repo>/`

That's the whole thing. Drop GPX files in and everything works — the map, the
transfer drawing, the elevation profile, the animation, and all the file
exports. Your rides live in your own browser and are never uploaded.

### Sharing (optional)

Only the two **share links** need anything more, because a link has to be
hosted somewhere. Your copy ships with that switched off; Publish will simply say
sharing isn't configured.

To turn it on, follow [Setting it up](#setting-it-up) below — a free Firebase
project, no card — then add two repository variables under **Settings → Secrets
and variables → Actions → Variables**:

| Variable | Where it comes from |
|---|---|
| `FIREBASE_PROJECT_ID` | Firebase → Project settings → General |
| `FIREBASE_API_KEY` | the same page, under Your apps → Web |

Re-run the workflow from the **Actions** tab and Publish starts working. The
deploy writes those into the site for you; nobody's keys are ever committed, so
a copy of this repo can never write to somebody else's database.

---

## Use it

Open **[the app](https://jkevincrowley.github.io/route-studio/)** — or clone the
repo and open `index.html`. There is no build step and nothing to install.

### 1. Add rides

Drag `.gpx` files onto the window. Most apps export them: Ride with GPS
(*ride → Export → GPX Track*), Strava (*⋯ → Export GPX*), Garmin Connect,
Komoot, Wahoo.

Or open **Sync from Ride with GPS**, set an optional date range, and paste an
API key and auth token from
[ridewithgps.com/settings/developers](https://ridewithgps.com/settings/developers).
Those calls go straight from your browser to ridewithgps.com — their API allows
it — so no server sees your keys. They're kept in this browser's local storage
and **Forget keys** removes them.

The date range filters *before* anything is downloaded, so a narrow window
syncs in seconds rather than fetching your whole account. Leave both blank for
everything.

Rides are ordered by the timestamp inside each file. A file with no timestamps
falls back to its modification date, which can put it out of order; the app says
so when it happens.

### 2. Draw the transfers

Open **Transfers**, pick how you travelled, optionally name the leg, then
**Start drawing** and click along the real route on the map. Double-click to
finish. Curve the ferry around the headland, follow the rails — it's your line.

The panel tells you how many continuous runs you have. Every transfer that
bridges a gap merges two runs into one.

**Gaps you don't draw stay undrawn.** Two tours a year apart shouldn't be joined
by a line across a continent you never crossed, so the app never invents one —
and the animation jumps that gap rather than gliding over it.

### 3. Animate

**Animate** plays a dot along the joined route. Scrub, change speed, choose
whether the line draws itself as the dot moves, and optionally keep the dot
centred.

### 4. Export

| Export | What you get |
|---|---|
| **Share the animated map** | A link to the journey animating on a map. Chapters are deliberately left out, so writing meant for one audience cannot ride along to another. |
| **Share the story** | A link that opens straight into the chapters, scrolled through with the map drawing beneath. Closing the story leaves the same map behind. |
| **Animated map (HTML)** | One self-contained file with the map, transfers and a working animation — the map only, no chapters. Upload it anywhere — GitHub Pages, Netlify, any web host. |
| **Route line (GeoJSON)** | One `LineString` per continuous run, with distance and which transfers bridged it. |
| **Route line (GPX)** | The joined route as a track, one segment per run. |
| **Project file** | Everything, for backup or moving to another machine. |

---

## What the numbers mean

The totals appear as a panel at the top of the **Rides** tab, and on the
title card of any map you export.

**Distance, climbing and time count the recorded rides only.** Transfers are
lines you drew across ground covered by ferry, train or bus, so including them
would inflate every figure with distance nobody pedalled. The Transfers panel
shows the two separately — ridden kilometres, then transfer kilometres.

**Climbing** is read from the elevation values on the track: `<ele>` in a GPX
file, or the elevation on each Ride with GPS track point. It is smoothed over a
short window before positive moves are totalled, because both GPS and
barometric elevation jitter by a metre or two even at a standstill, and summing
raw deltas turns a cafe stop into hundreds of phantom metres — in testing, 400 m
from a stationary trace. Rides whose files carry no elevation are left out of
the total, and the panel says how many.

**Time** uses Ride with GPS's `duration` field, which is moving time. GPX has no
equivalent, so for uploaded files it is the elapsed time between the first and
last stamped point — that includes stops, and the label says which you're
looking at.

## Settings worth knowing

**Simplify (metres)** — raw GPS logs a point every few metres, far finer than a
map of a whole country can show. Ramer–Douglas–Peucker at this tolerance
guarantees no point moves further than the value you set. On a real 208,000-point
journey, 10 m keeps about a quarter of the points and cuts the page from 4.4 MB
to 1.2 MB with no visible change. Set `0` to keep every point.

**Map style** — dark, light or terrain, switched live.

The basemap is [VersaTiles](https://versatiles.org) *Muted* — OpenStreetMap
vector tiles, open source, **no API key and no quota**.

**MapLibre GL is the map**, not just the basemap: it owns the camera and draws
the route, the transfers and the animation as GL layers. It previously rendered
only the tiles, inside Leaflet, which left Leaflet driving the camera — zoom
moved in whole steps and every pan re-projected and repainted the whole track
on a 2D canvas. Handing both jobs to the GPU is what makes panning and zooming
continuous on a journey of any length.

The style ships `projection: {type: "globe"}`, which `loadStyle()` in `app.js`
rewrites to `mercator`. That used to be mandatory, because Leaflet's overlays
were Web Mercator and a globe basemap slid out from under them. Every overlay
is a GL layer now, so a globe would line up — Mercator is kept only because it
is how the map has always looked, and dropping that one line tries the globe.

Attribution is a licence condition, and appears in the map's own corner
credit. Keep it if you publish.

**Join tolerance (km)** — how close two line ends must be to count as joined.
Raise it if a transfer you drew doesn't merge its runs; lower it if separate
tours are being stitched together when they shouldn't be. If a transfer matches
nothing, the panel says so.

---

## Your data

Rides, transfers and settings live in **IndexedDB in this browser**, on this
machine. Nothing is uploaded, and there is no account because there is nothing
to log in to.

The flip side: **clearing your browser data deletes your project.** Export a
project file now and then. Private/incognito windows usually discard storage
when closed, and some browsers evict IndexedDB for sites you rarely visit.

A map you export and publish is public — including precise routes. If your rides
start at your front door, trim them before publishing.

---

## Running it locally

```bash
git clone https://github.com/jkevincrowley/route-studio.git
cd route-studio
open index.html          # or just double-click it
```

MapLibre GL loads from unpkg, so the first load needs a connection. Everything
else is local.

To host your own copy, push to GitHub and turn on **Settings → Pages → Deploy
from a branch → main**.

---

## How it works

```
index.html   markup and layout
app.css      styling
app.js       everything else, ~900 lines, no framework
```

Notable pieces, all in `app.js`:

- **`simplify`** — iterative Ramer–Douglas–Peucker. Iterative rather than
  recursive because a 20,000-point ride would blow the stack.
- **`joinJourney`** — concatenates rides in date order, splicing in transfers
  whose ends land near a gap, reversing any drawn against the direction of
  travel. Refuses to bridge a gap with no transfer.
- **`prepareAnim`** — records run boundaries and gives them zero length, so the
  dot teleports across an undrawn gap instead of implying travel.
- **`shareableHTML`** — serialises the current project into a standalone page
  carrying its own copy of the animation.

On performance: the animated path gets its own, coarser point budget
(`MAX_ANIM_POINTS`) than the static map, and the dot and trail layers are
created once and updated in place. Together those took a 208,000-point journey
from 18 fps to comfortably past the display refresh rate — the map itself keeps
full detail.

---

## Licence

MIT.
