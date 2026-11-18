// Loading, caching and describing places (restrooms and drinking water).
//
// Data comes live from OpenStreetMap through the public Overpass API, so the
// site needs no backend of its own. The world is split into a fixed grid of
// small cells; each cell is fetched at most once per session and kept in
// localStorage so a runner reopening the page sees pins immediately.

export const MIN_ZOOM = 12; // below this the visible area is too big to query
export const CELLS_PER_DEGREE = 20; // 0.05° cells, roughly 5 km tall
export const MAX_CELLS = 600; // refuse absurdly large areas
const FRESH_MS = 3 * 24 * 60 * 60 * 1000; // refetch cached cells after 3 days
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // never show cache older than this
const CACHE_PREFIX = 'poop:cell:v1:';
const REQUEST_TIMEOUT_MS = 30000;

// Public Overpass instances, tried in order. All send CORS headers.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Only these tags are kept, to keep memory and the cache small.
const KEPT_TAGS = [
  'name', 'operator', 'description', 'opening_hours', 'fee', 'charge', 'access',
  'wheelchair', 'changing_table', 'unisex', 'toilets:disposal', 'drinking_water',
  'bottle', 'seasonal', 'indoor', 'amenity', 'man_made',
];

/** Overpass QL for every restroom and drinking-water feature in a bbox. */
export function buildQuery({ s, w, n, e }) {
  const bbox = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
  return (
    `[out:json][timeout:25][bbox:${bbox}];(` +
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
   * side effect; `missing` lists the cells that still need the network.
   */
  plan(bounds) {
    const keys = cellsForBounds(bounds);
    if (keys === null) return { tooBig: true, missing: [], hydrated: false };
    let hydrated = false;
    const missing = [];
    for (const key of keys) {
      if (this.fresh.has(key)) continue;
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
    return { tooBig: false, missing, hydrated };
  }

  /**
   * Make sure every place inside the bounds is loaded.
   * Resolves to { changed, tooBig }; rejects if the network request fails.
   */
  async ensure(bounds, { signal } = {}) {
    const { tooBig, missing, hydrated } = this.plan(bounds);
    if (tooBig) return { changed: false, tooBig: true };
    if (!missing.length) return { changed: hydrated, tooBig: false };

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
        this.#writeCache(key, byCell.get(key) || []);
      }
    }
    return { changed: true, tooBig: false };
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
