# PrincipalOperatingObjectivePlanner (POOP)

A mobile-friendly map of public restrooms and water fountains, built for runners.
Open the page, tap **Find the nearest to me**, and see the closest places to stop,
sorted by distance, with walking directions one tap away.

## How it works

- **Fully static.** Everything in `public/` is plain HTML, CSS and JavaScript.
  There is no build step, no server code and no database.
- **Map:** [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles. Leaflet is
  vendored in `public/vendor/`, so the site loads no third-party scripts.
- **Data:** restrooms and drinking water come from
  [OpenStreetMap](https://www.openstreetmap.org/).
  - *United States:* a weekly GitHub Action downloads every place and commits
    it to `public/data/tiles/` as small JSON files. Visitors load these from
    Cloudflare, the same host as the site, so pins appear quickly and do not
    depend on any third-party server being up.
  - *Everywhere else:* the browser asks a public
    [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) server
    directly. These volunteer-run servers (in Germany and Austria) can be slow
    or busy, so results are cached on the phone for three days.
- **Location** never leaves the device. It is only used to centre the map and
  sort the list.

What is shown: `amenity=toilets`, `amenity=drinking_water`, `amenity=water_point`,
and taps or fountains tagged `drinking_water=yes`. Places tagged `access=private`
or `access=no` are hidden.

## Deploy to Cloudflare (free plan)

Cloudflare's dashboard offers two ways to host a static site from Git. Both are
free for this site and both honour `public/_headers`.

### Workers (the default "Import a repository" flow)

This is the form that asks for a **build command**, **deploy command**,
**preview command** and **path**. `wrangler.jsonc` in this repository already
tells Cloudflare to serve `public/`, so leave every field at its default:

| Setting         | Value                              |
| --------------- | ---------------------------------- |
| Build command   | *(empty)*                          |
| Deploy command  | `npx wrangler deploy` (default)    |
| Preview command | `npx wrangler preview` (default)   |
| Path            | `/` (default)                      |

Naming the project `principaloperatingobjectiveplanner` matches `wrangler.jsonc`.
Any other name still deploys; Cloudflare just opens a pull request offering to
update the name in that file.

### Pages (the classic flow)

**Workers & Pages → Create application → Pages → Import an existing Git
repository**, then:

| Setting                | Value    |
| ---------------------- | -------- |
| Production branch      | `main`   |
| Framework preset       | None     |
| Build command          | `exit 0` |
| Build output directory | `public` |

Either way the site is published on a free Cloudflare subdomain and redeploys on
every push to `main`. It fits well inside the free plan: about 25 small files,
no server code, and requests for static files are free and unlimited. HTTPS is
automatic, which the browser requires before it will share a location.

`public/_headers` sets security headers, including a Content-Security-Policy.
If you ever change the tile server or the Overpass servers, update the
`img-src` / `connect-src` lists there as well as the URLs in `public/js/`.

## Keeping the data fresh

`.github/workflows/update-data.yml` runs `scripts/build-data.mjs` every Monday.
It downloads the data in about 190 requests, rebuilds `public/data/tiles/`, and
commits the result; Cloudflare then redeploys the site. If the download fails,
or suddenly returns far fewer places than last time, nothing is changed.

- **Run it now:** on GitHub, open **Actions → Update map data → Run workflow**.
- **Run it on your computer:** `npm run build-data` (takes 15 to 40 minutes).
- **Cover more of the world:** add a box to `REGIONS` at the top of
  `scripts/build-data.mjs`. The free Cloudflare plan allows 20,000 files; the
  United States uses a few thousand.

GitHub pauses scheduled workflows in repositories with no activity for 60 days.
If the Monday runs stop, re-enable the workflow on the Actions tab.

## Adding places that are not on the map

**Best:** add them to OpenStreetMap. They then appear here (and in every other
OSM-based app) after the next weekly update. On a phone,
[StreetComplete](https://streetcomplete.app/) and
[Every Door](https://every-door.app/) make this easy.

**Community-only spots** (for example a running shop that lets club members use
its restroom) can go in `public/data/community.json`:

```json
[
  {
    "id": "fleet-feet",
    "kind": "toilet",
    "lat": 40.7712,
    "lon": -73.9742,
    "name": "Fleet Feet (ask at the counter)",
    "notes": "Runners welcome during opening hours.",
    "hours": "Mo-Sa 10:00-19:00"
  }
]
```

`kind` is `"toilet"` or `"water"`; `id`, `kind`, `lat` and `lon` are required.
Commit the change and Cloudflare redeploys the site.

## Develop locally

```bash
npm run dev
```

serves `public/` at <http://localhost:8788>. Any static file server works. To
also exercise the `_headers` file exactly as Cloudflare does:

```bash
npx wrangler dev
```

Run the unit tests (Node 20 or newer, no dependencies to install):

```bash
npm test
```

## Project layout

```
public/
  index.html            page shell
  styles.css            mobile-first styles (bottom sheet on phones, side panel on desktop)
  js/app.js             map, list, detail view, geolocation
  js/data.js            loading places (static tiles or Overpass), caching, tag descriptions
  js/util.js            distance and URL helpers
  data/community.json   optional hand-maintained places
  data/tiles/           pre-built place data (generated, do not edit by hand)
  vendor/               Leaflet 1.9.4 and Leaflet.markercluster 1.5.3
  _headers              Cloudflare response headers
  manifest.webmanifest  lets people add POOP to their home screen
scripts/build-data.mjs  downloads the place data and writes data/tiles/
.github/workflows/      weekly data update
tests/                  unit tests for the data code and the build script
wrangler.jsonc          tells Cloudflare to serve public/
```

## Credits

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under the Open Database License. Map tiles by OpenStreetMap. The
public tile and Overpass servers are run by volunteers for light use; if the
site becomes very popular, switch to a commercial tile provider.
