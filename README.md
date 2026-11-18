# PrincipalOperatingObjectivePlanner (POOP)

A mobile-friendly map of public restrooms and water fountains, built for runners.
Open the page, tap **Find the nearest to me**, and see the closest places to stop,
sorted by distance, with walking directions one tap away.

## How it works

- **Fully static.** Everything in `public/` is plain HTML, CSS and JavaScript.
  There is no build step, no server code and no database.
- **Map:** [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles. Leaflet is
  vendored in `public/vendor/`, so the site loads no third-party scripts.
- **Data:** restrooms and drinking water are read live from
  [OpenStreetMap](https://www.openstreetmap.org/) through the public
  [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API), straight from
  the visitor's browser. Results are cached on the phone for three days so
  reopening the page is instant. If one Overpass server is busy, the app tries
  two others.
- **Location** never leaves the device. It is only used to centre the map and
  sort the list.

What is shown: `amenity=toilets`, `amenity=drinking_water`, `amenity=water_point`,
and taps or fountains tagged `drinking_water=yes`. Places tagged `access=private`
or `access=no` are hidden.

## Deploy to Cloudflare Pages (free plan)

1. In the Cloudflare dashboard go to **Workers & Pages → Create application →
   Pages → Import an existing Git repository** and pick this repository.
2. Use these build settings:

   | Setting                | Value    |
   | ---------------------- | -------- |
   | Production branch      | `main`   |
   | Framework preset       | None     |
   | Build command          | `exit 0` |
   | Build output directory | `public` |

3. Save and deploy. The site is published at `https://<project>.pages.dev`, and
   every push to the production branch redeploys it. Other branches and pull
   requests get preview URLs.

The site fits well inside the free plan: it is about 20 files (the limit is
20,000 files of up to 25 MiB each), static requests are not metered, and it uses
no Pages Functions. HTTPS is automatic, which the browser requires before it
will share a location.

`public/_headers` sets security headers, including a Content-Security-Policy.
If you ever change the tile server or the Overpass servers, update the
`img-src` / `connect-src` lists there as well as the URLs in `public/js/`.

## Adding places that are not on the map

**Best:** add them to OpenStreetMap. They then appear here (and in every other
OSM-based app) within a few days. On a phone,
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
npx wrangler pages dev public
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
  js/data.js            Overpass loading, caching, tag descriptions
  js/util.js            distance and URL helpers
  data/community.json   optional hand-maintained places
  vendor/               Leaflet 1.9.4 and Leaflet.markercluster 1.5.3
  _headers              Cloudflare Pages response headers
  manifest.webmanifest  lets people add POOP to their home screen
tests/                  unit tests for js/data.js and js/util.js
```

## Credits

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under the Open Database License. Map tiles by OpenStreetMap. The
public tile and Overpass servers are run by volunteers for light use; if the
site becomes very popular, switch to a commercial tile provider.
