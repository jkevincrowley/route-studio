# Route Studio

Turn a pile of recorded rides into one continuous journey — draw the ferries,
trains and buses that link them, then animate a dot along the whole thing.

**Everything runs in your browser.** No account, no server, no upload. Your
rides stay on your machine.

![Rides, transfers, animation and export in one window](docs/screenshot.png)

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

## Use it

Open **[the app](https://YOUR-USERNAME.github.io/route-studio/)** — or clone the
repo and open `index.html`. There is no build step and nothing to install.

### 1. Add rides

Drag `.gpx` files onto the window. Most apps export them: Ride with GPS
(*ride → Export → GPX Track*), Strava (*⋯ → Export GPX*), Garmin Connect,
Komoot, Wahoo.

Or open **Sync from Ride with GPS** and paste an API key and auth token from
[ridewithgps.com/settings/developers](https://ridewithgps.com/settings/developers).
Those calls go straight from your browser to ridewithgps.com — their API allows
it — so no server sees your keys. They're kept in this browser's local storage
and **Forget keys** removes them.

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
| **Shareable map (HTML)** | One self-contained file with the map, transfers and a working animation. Upload it anywhere — GitHub Pages, Netlify, any web host. |
| **Route line (GeoJSON)** | One `LineString` per continuous run, with distance and which transfers bridged it. |
| **Route line (GPX)** | The joined route as a track, one segment per run. |
| **Project file** | Everything, for backup or moving to another machine. |

---

## Settings worth knowing

**Simplify (metres)** — raw GPS logs a point every few metres, far finer than a
map of a whole country can show. Ramer–Douglas–Peucker at this tolerance
guarantees no point moves further than the value you set. On a real 208,000-point
journey, 10 m keeps about a quarter of the points and cuts the page from 4.4 MB
to 1.2 MB with no visible change. Set `0` to keep every point.

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
git clone https://github.com/YOUR-USERNAME/route-studio.git
cd route-studio
open index.html          # or just double-click it
```

Leaflet and Leaflet.draw load from unpkg, so the first load needs a connection.
Everything else is local.

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

---

## Licence

MIT.
