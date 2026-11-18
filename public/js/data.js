// Loading, caching and describing places (restrooms and drinking water).
//
// All data comes from OpenStreetMap, by one of two routes:
//
// 1. Static tiles. scripts/build-data.mjs downloads every place in the regions
//    it is configured for (the United States by default) and writes them to
//    public/data/tiles/ as small JSON files. They are served by the same host
//    as the site, so they load quickly and reliably.
// 2. Live queries. Anywhere the tiles do not cover, the browser asks a public
//    Overpass API server directly. These volunteer-run servers can be slow or
//    busy, so results are kept in localStorage for a few days.
//
// The world is split into a fixed grid of small cells so each area is fetched
// at most once per session.

export const MIN_ZOOM = 12; // below this the visible area is too big to query
export const CELLS_PER_DEGREE = 20; // 0.05° cells, roughly 5 km tall
export const MAX_CELLS = 600; // refuse absurdly large areas
const FRESH_MS = 3 * 24 * 60 * 60 * 1000; // refetch cached cells after 3 days
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // never show cache older than this
const CACHE_PREFIX = 'poop:cell:v1:';
const REQUEST_TIMEOUT_MS = 30000;

export const TILE_DEGREES = 0.5; // size of one static tile
export const TILE_BASE_URL = 'data/tiles';

// Public Overpass instances, tried in order. Both send CORS headers.
// If you change this list, update connect-src in public/_headers too.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Only these tags are kept, to keep memory and the cache small.
const KEPT_TAGS = [
  'name', 'operator', 'description', 'opening_hours', 'fee', 'charge', 'access',
  'wheelchair', 'changing_table', 'unisex', 'toilets:disposal', 'drinking_water',
  'bottle', 'seasonal', 'indoor', 'amenity', 'man_made',
];

/** Overpass QL for every restroom and drinking-water feature in a bbox. */
export function buildQuery({ s, w, n, e }, { timeout = 25 } = {}) {
  const bbox = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
  return (
    `[out:json][timeout:${timeout}][bbox:${bbox}];(` +
    'nwr["amenity"="toilets"];' +
    'nwr["amenity"="drinking_water"];' +
    'nwr["amenity"="water_point"];' +
    'nwr["man_made"="water_tap"]["drinking_water"="yes"];' +
    'nwr["amenity"="fountain"]["drinking_water"="yes"];' +
    ');out tags center qt;'
  );
}

/** Turn a raw Overpass element into a place, or null if it isn't usable. */
export function normalizeElement(el) {
  if (!el || !el.type || el.id == null) return null;
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (tags.access === 'private' || tags.access === 'no') return null;

  let kind;
  if (tags.amenity === 'toilets') kind = 'toilet';
  else if (
    tags.amenity === 'drinking_water' ||
    tags.amenity === 'water_point' ||
    tags.drinking_water === 'yes'
  ) kind = 'water';
  else return null;
  if (kind === 'water' && tags.drinking_water === 'no') return null;

  const kept = {};
  for (const key of KEPT_TAGS) {
    if (typeof tags[key] === 'string' && tags[key]) kept[key] = tags[key].slice(0, 300);
  }
  return { id: `${el.type[0]}${el.id}`, kind, lat, lon, tags: kept };
}

/** Compact array form of a place, used in the static tile files. */
export function packPlace(place) {
  return [place.id, place.kind[0], Number(place.lat.toFixed(5)), Number(place.lon.toFixed(5)), place.tags];
}

export function unpackPlace(row) {
  if (!Array.isArray(row) || typeof row[0] !== 'string') return null;
  const [id, kind, lat, lon, tags] = row;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { id, kind: kind === 't' ? 'toilet' : 'water', lat, lon, tags: tags || {} };
}

/** Name of the static tile containing a point, e.g. "261_212". */
export function tileKeyFor(lat, lon, degrees = TILE_DEGREES) {
  const y = Math.floor((Math.min(lat, 89.99999) + 90) / degrees + 1e-9);
  const x = Math.floor((Math.min(lon, 179.99999) + 180) / degrees + 1e-9);
  return `${y}_${x}`;
}

/** Validate an entry from data/community.json. */
export function normalizeCommunity(entry, index) {
  if (!entry || (entry.kind !== 'toilet' && entry.kind !== 'water')) return null;
  const lat = Number(entry.lat);
  const lon = Number(entry.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  const tags = {};
  if (entry.name) tags.name = String(entry.name).slice(0, 300);
  if (entry.notes) tags.description = String(entry.notes).slice(0, 300);
  if (entry.hours) tags.opening_hours = String(entry.hours).slice(0, 300);
  return { id: `c${entry.id ?? index}`, kind: entry.kind, lat, lon, tags, community: true };
}

/** Link to the OpenStreetMap page of a place (null for community entries). */
export function osmUrl(place) {
  const type = { n: 'node', w: 'way', r: 'relation' }[place.id[0]];
  return type && !place.community
    ? `https://www.openstreetmap.org/${type}/${place.id.slice(1)}`
    : null;
}

/** Everything the UI shows about a place, as plain text (never HTML). */
export function describePlace(place) {
  const t = place.tags || {};
  const isToilet = place.kind === 'toilet';
  const isTap = t.amenity === 'water_point' || (t.man_made === 'water_tap' && t.amenity !== 'drinking_water');
  const typeLabel = isToilet ? 'Restroom' : isTap ? 'Water tap' : 'Water fountain';
  const title = t.name || (isToilet ? 'Public restroom' : isTap ? 'Water tap' : 'Water fountain');
  const facts = [];
  const add = (text, tone = 'info') => facts.push({ text, tone });

  if (place.community) add('Added by our community', 'good');
  if (t.opening_hours === '24/7') add('Open 24/7', 'good');
  if (t.access === 'customers') add('Customers only', 'warn');
  if (t.fee === 'yes') add(t.charge ? `Fee: ${t.charge}` : 'Fee charged', 'warn');
  else if (t.fee === 'no') add('Free', 'good');
  if (t.seasonal && t.seasonal !== 'no') {
    add(isToilet ? 'Seasonal: may be closed off-season' : 'Seasonal: may be shut off in winter', 'warn');
  }
  if (!isToilet && t.bottle === 'yes') add('Bottle filler', 'good');
  if (isToilet && t.drinking_water === 'yes') add('Drinking water here', 'good');
  if (t.wheelchair === 'yes') add('Wheelchair accessible', 'good');
  else if (t.wheelchair === 'limited') add('Limited wheelchair access');
  else if (t.wheelchair === 'no') add('Not wheelchair accessible');
  if (t.changing_table === 'yes') add('Changing table');
  if (t.unisex === 'yes') add('Unisex');
  if (t['toilets:disposal'] === 'pitlatrine') add('Pit toilet');
  else if (t['toilets:disposal'] === 'chemical') add('Portable toilet');
  if (t.indoor === 'yes') add('Indoors');

  return {
    title,
    typeLabel,
    operator: t.operator && t.operator !== t.name ? t.operator : '',
    hours: t.opening_hours && t.opening_hours !== '24/7' ? t.opening_hours : '',
    description: t.description || '',
    facts,
    summary: facts.slice(0, 3).map((f) => f.text).join(' · '),
  };
}

// ---- grid helpers ---------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cellX = (lon) => Math.floor((clamp(lon, -180, 179.99999) + 180) * CELLS_PER_DEGREE + 1e-9);
const cellY = (lat) => Math.floor((clamp(lat, -90, 89.99999) + 90) * CELLS_PER_DEGREE + 1e-9);
const cellKey = (x, y) => `${x}:${y}`;
export const cellKeyFor = (lat, lon) => cellKey(cellX(lon), cellY(lat));

/** Keys of every grid cell touching the bounds, or null if there are too many. */
export function cellsForBounds({ s, w, n, e }) {
  const x0 = cellX(w), x1 = cellX(e), y0 = cellY(s), y1 = cellY(n);
  if (x1 < x0 || y1 < y0) return [];
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) return null;
  const keys = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(cellKey(x, y));
  return keys;
}

function boundsOfCells(keys) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const key of keys) {
    const [x, y] = key.split(':').map(Number);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return {
    x0, x1, y0, y1,
    s: y0 / CELLS_PER_DEGREE - 90,
    n: (y1 + 1) / CELLS_PER_DEGREE - 90,
    w: x0 / CELLS_PER_DEGREE - 180,
    e: (x1 + 1) / CELLS_PER_DEGREE - 180,
  };
}

// ---- the store ------------------------------------------------------------

export class PlaceStore {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {Storage|null} [opts.storage] localStorage-like cache, or null
   * @param {() => number} [opts.now]
   * @param {string[]} [opts.endpoints]
   */
  constructor({ fetchImpl, storage = null, now = Date.now, endpoints = OVERPASS_ENDPOINTS } = {}) {
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.storage = storage;
    this.now = now;
    this.endpoints = [...endpoints];
    this.places = new Map(); // id -> place
    this.fresh = new Set(); // cells that need no fetching
    this.checked = new Set(); // cells already looked up in the cache
    this.coverage = null; // what the static tiles cover, once known
    this.tilesLoaded = new Set();
    this.tileBase = TILE_BASE_URL;
  }

  /** Fetch the static tile index. Without it everything is queried live. */
  async loadIndex(url = `${TILE_BASE_URL}/index.json`) {
    try {
      const res = await this.fetchImpl(url);
      if (res.ok) this.setCoverage(await res.json());
    } catch {
      /* no static data available: fall back to live queries */
    }
    return Boolean(this.coverage);
  }

  /** Use a parsed tile index ({ tileDegrees, regions, rows }). */
  setCoverage(index) {
    this.coverage = null;
    const degrees = Number(index?.tileDegrees);
    const cellsPerTile = Math.round(degrees * CELLS_PER_DEGREE);
    if (!Array.isArray(index?.regions) || !index.regions.length || cellsPerTile < 1) return;
    const tiles = new Set();
    for (const [y, xs] of Object.entries(index.rows || {})) for (const x of xs) tiles.add(`${y}_${x}`);
    this.coverage = { regions: index.regions, cellsPerTile, tiles, generated: index.generated || '' };
  }

  /** Static tile holding a grid cell, or null where only live data exists. */
  #tileForCell(key) {
    if (!this.coverage) return null;
    const [x, y] = key.split(':').map(Number);
    const lat = (y + 0.5) / CELLS_PER_DEGREE - 90;
    const lon = (x + 0.5) / CELLS_PER_DEGREE - 180;
    const covered = this.coverage.regions.some(([s, w, n, e]) => lat > s && lat < n && lon > w && lon < e);
    if (!covered) return null;
    const { cellsPerTile } = this.coverage;
    return `${Math.floor(y / cellsPerTile)}_${Math.floor(x / cellsPerTile)}`;
  }

  addCommunity(entries) {
    let count = 0;
    (Array.isArray(entries) ? entries : []).forEach((entry, i) => {
      const place = normalizeCommunity(entry, i);
      if (place) { this.places.set(place.id, place); count++; }
    });
    return count;
  }

  /**
   * Work out what a view needs. Cached cells are loaded into `places` as a
   * side effect. `tiles` lists the static tiles still to download and
   * `missing` the cells that need a live Overpass query.
   */
  plan(bounds) {
    const keys = cellsForBounds(bounds);
    if (keys === null) return { tooBig: true, missing: [], tiles: [], hydrated: false };
    let hydrated = false;
    const missing = [];
    const tiles = new Set();
    for (const key of keys) {
      if (this.fresh.has(key)) continue;
      const tile = this.#tileForCell(key);
      if (tile) {
        if (!this.tilesLoaded.has(tile)) tiles.add(tile);
        continue;
      }
      if (!this.checked.has(key)) {
        this.checked.add(key);
        const cached = this.#readCache(key);
        if (cached) {
          for (const place of cached.places) this.places.set(place.id, place);
          hydrated = hydrated || cached.places.length > 0;
          if (cached.fresh) { this.fresh.add(key); continue; }
        }
      }
      missing.push(key);
    }
    return { tooBig: false, missing, tiles: [...tiles], hydrated };
  }

  /**
   * Make sure every place inside the bounds is loaded.
   * Resolves to { changed, tooBig }; rejects if a network request fails.
   */
  async ensure(bounds, { signal } = {}) {
    const { tooBig, missing, tiles, hydrated } = this.plan(bounds);
    if (tooBig) return { changed: false, tooBig: true };
    if (!missing.length && !tiles.length) return { changed: hydrated, tooBig: false };

    await Promise.all(tiles.map((tile) => this.#loadTile(tile, signal)));
    if (!missing.length) return { changed: true, tooBig: false };

    const box = boundsOfCells(missing);
    const elements = await this.#fetchElements(box, signal);

    // Replace whatever we had for the fetched area (drops deleted places).
    const inBox = (place) => {
      const x = cellX(place.lon), y = cellY(place.lat);
      return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
    };
    for (const [id, place] of this.places) {
      if (!place.community && inBox(place)) this.places.delete(id);
    }
    const byCell = new Map();
    for (const el of elements) {
      const place = normalizeElement(el);
      if (!place || !inBox(place)) continue;
      this.places.set(place.id, place);
      const key = cellKeyFor(place.lat, place.lon);
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(place);
    }
    for (let x = box.x0; x <= box.x1; x++) {
      for (let y = box.y0; y <= box.y1; y++) {
        const key = cellKey(x, y);
        this.fresh.add(key);
        this.checked.add(key);
        if (!this.#tileForCell(key)) this.#writeCache(key, byCell.get(key) || []);
      }
    }
    return { changed: true, tooBig: false };
  }

  async #loadTile(tile, signal) {
    // Tiles missing from the index are simply empty: nothing to download.
    if (this.coverage.tiles.has(tile)) {
      const res = await this.fetchImpl(`${this.tileBase}/${tile}.json`, { signal });
      if (!res.ok) throw new Error(`Tile ${tile} answered HTTP ${res.status}`);
      const json = await res.json();
      for (const row of Array.isArray(json?.p) ? json.p : []) {
        const place = unpackPlace(row);
        if (place) this.places.set(place.id, place);
      }
    }
    this.tilesLoaded.add(tile);
  }

  async #fetchElements(box, outerSignal) {
    const body = new URLSearchParams({ data: buildQuery(box) });
    let lastError = new Error('No Overpass endpoint configured');
    for (let i = 0; i < this.endpoints.length; i++) {
      const url = this.endpoints[i];
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
      outerSignal?.addEventListener('abort', abort, { once: true });
      try {
        if (outerSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const res = await this.fetchImpl(url, { method: 'POST', body, signal: controller.signal });
        if (!res.ok) throw new Error(`Overpass answered HTTP ${res.status}`);
        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) throw new Error('Unexpected Overpass response');
        if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
        // Remember the server that worked so the next request tries it first.
        if (i > 0) this.endpoints.unshift(...this.endpoints.splice(i, 1));
        return json.elements;
      } catch (err) {
        if (outerSignal?.aborted) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', abort);
      }
    }
    throw lastError;
  }

  // ---- localStorage cache -------------------------------------------------

  #readCache(key) {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      const age = this.now() - entry.t;
      if (!Array.isArray(entry.p) || !(age >= 0) || age > EXPIRE_MS) {
        this.storage.removeItem(CACHE_PREFIX + key);
        return null;
      }
      return { places: entry.p, fresh: age < FRESH_MS };
    } catch {
      return null;
    }
  }

  #writeCache(key, places) {
    if (!this.storage || this.cacheFull) return;
    const value = JSON.stringify({ t: this.now(), p: places });
    try {
      this.storage.setItem(CACHE_PREFIX + key, value);
    } catch {
      // Storage is full: drop the older half of our cells and try once more.
      try {
        this.#evictOldest();
        this.storage.setItem(CACHE_PREFIX + key, value);
      } catch {
        this.cacheFull = true; // stop trying for this session
      }
    }
  }

  #evictOldest() {
    const entries = [];
    for (let i = 0; i < this.storage.length; i++) {
      const name = this.storage.key(i);
      if (!name || !name.startsWith(CACHE_PREFIX)) continue;
      let t = 0;
      try { t = JSON.parse(this.storage.getItem(name)).t || 0; } catch { /* corrupt: evict first */ }
      entries.push({ name, t });
    }
    entries.sort((a, b) => a.t - b.t);
    for (const { name } of entries.slice(0, Math.ceil(entries.length / 2))) {
      this.storage.removeItem(name);
    }
  }
}
