#!/usr/bin/env node
// Builds the static place data served from public/data/tiles/.
//
// Downloads every restroom and drinking-water spot inside REGIONS from
// OpenStreetMap (through the Overpass API), then writes one small JSON file
// per half-degree tile plus an index. The website reads these files instead
// of querying Overpass from each visitor's phone, which is far faster and
// does not depend on the public Overpass servers being up.
//
//   node scripts/build-data.mjs          rebuild everything
//   node scripts/build-data.mjs --force  also accept a much smaller result
//
// .github/workflows/update-data.yml runs this every week.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TILE_DEGREES, buildQuery, normalizeElement, packPlace, tileKeyFor } from '../public/js/data.js';

// Areas to include, as [south, west, north, east]. Every number must be a
// multiple of TILE_DEGREES (0.5). Anywhere outside these boxes still works on
// the site; it is just loaded live, and more slowly, from Overpass.
export const REGIONS = [
  { name: 'Contiguous United States', bbox: [24, -125, 49.5, -66.5] },
  { name: 'Alaska', bbox: [51, -180, 71.5, -129.5] },
  { name: 'Hawaii', bbox: [18.5, -160.5, 22.5, -154.5] },
  { name: 'Puerto Rico and US Virgin Islands', bbox: [17.5, -67.5, 19, -64.5] },
];

// Each request to Overpass costs half a minute or more however little it
// returns, so ask for big boxes: the whole download is about 14 requests.
// A box that proves too big for the server is split into smaller ones.
const CHUNK_DEGREES = 20;
const MAX_SPLITS = 3; // 20° -> 10° -> 5° -> 2.5°
const QUERY_TIMEOUT_S = 300;
const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
// Overpass operators ask for an identifying User-Agent. Set OVERPASS_USER_AGENT
// to include a contact address if you would like them to be able to reach you.
const USER_AGENT = process.env.OVERPASS_USER_AGENT || 'restroom-map-data-builder/1.0';

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Split a box into equal pieces no larger than `size` degrees on a side. */
export function chunksFor([s, w, n, e], size = CHUNK_DEGREES) {
  const rows = Math.max(1, Math.ceil((n - s) / size - 1e-9));
  const cols = Math.max(1, Math.ceil((e - w) / size - 1e-9));
  const chunks = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      chunks.push([
        s + ((n - s) * r) / rows,
        w + ((e - w) * c) / cols,
        s + ((n - s) * (r + 1)) / rows,
        w + ((e - w) * (c + 1)) / cols,
      ]);
    }
  }
  return chunks;
}

async function queryOnce(url, bbox, fetchImpl) {
  const [s, w, n, e] = bbox;
  const res = await fetchImpl(url, {
    method: 'POST',
    body: new URLSearchParams({ data: buildQuery({ s, w, n, e }, { timeout: QUERY_TIMEOUT_S }) }),
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout((QUERY_TIMEOUT_S + 60) * 1000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.elements)) throw new Error('unexpected response');
  if (json.remark && /error|timed out/i.test(json.remark)) {
    // The server ran the query and gave up: asking again will not help.
    throw Object.assign(new Error(json.remark), { tooBig: true });
  }
  return json.elements;
}

/**
 * Fetch one box. Servers that keep failing are tried less: each failure is a
 * strike (a slow failure counts double) and the server with the fewest
 * strikes goes next. A box that cannot be fetched is split into smaller ones.
 */
async function fetchBox(bbox, opts, depth = 0) {
  const { fetchImpl, endpoints, attempts, sleep, log, strikes, clock } = opts;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = endpoints.reduce((best, u) => (strikes.get(u) < strikes.get(best) ? u : best));
    const started = clock();
    try {
      const elements = await queryOnce(url, bbox, fetchImpl);
      strikes.set(url, 0);
      return elements;
    } catch (err) {
      lastError = err;
      const slow = clock() - started > 60000;
      log(`  attempt ${attempt + 1}/${attempts} at ${new URL(url).host} failed: ${err.message}`);
      if (err.tooBig) break;
      strikes.set(url, strikes.get(url) + (slow ? 2 : 1));
      await sleep(Math.min(60000, 5000 * 2 ** attempt));
    }
  }
  if (depth >= MAX_SPLITS) throw new Error(`Giving up on ${bbox.join(',')}: ${lastError.message}`);
  log(`  splitting ${bbox.join(',')} into smaller boxes`);
  const [s, w, n, e] = bbox;
  const elements = [];
  for (const quarter of chunksFor(bbox, Math.max(n - s, e - w) / 2)) {
    elements.push(...(await fetchBox(quarter, opts, depth + 1)));
    await sleep(2000);
  }
  return elements;
}

/**
 * Download all places and write the tiles. Nothing on disk changes unless
 * every request succeeded. Resolves to { count, tiles }.
 */
export async function buildData({
  outDir,
  regions = REGIONS,
  fetchImpl = fetch,
  endpoints = (process.env.OVERPASS_URLS || '').split(',').filter(Boolean),
  attempts = 4,
  sleep = realSleep,
  clock = Date.now,
  log = console.log,
  force = false,
  now = () => new Date(),
} = {}) {
  if (!endpoints.length) endpoints = DEFAULT_ENDPOINTS;
  for (const { name, bbox } of regions) {
    const aligned = bbox.every((v) => Number.isInteger(v / TILE_DEGREES));
    if (!aligned || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      throw new Error(`Region "${name}" must be [south, west, north, east] in multiples of ${TILE_DEGREES}`);
    }
  }
  const inRegions = (p) =>
    regions.some(({ bbox: [s, w, n, e] }) => p.lat >= s && p.lat < n && p.lon >= w && p.lon < e);

  const places = new Map();
  const strikes = new Map(endpoints.map((url) => [url, 0]));
  const opts = { fetchImpl, endpoints, attempts, sleep, log, strikes, clock };
  const startedAt = clock();
  for (const { name, bbox } of regions) {
    const chunks = chunksFor(bbox);
    log(`${name}: ${chunks.length} requests`);
    for (const [i, chunk] of chunks.entries()) {
      const elements = await fetchBox(chunk, opts);
      for (const element of elements) {
        const place = normalizeElement(element);
        if (place && inRegions(place)) places.set(place.id, place);
      }
      const minutes = ((clock() - startedAt) / 60000).toFixed(1);
      log(`  [${i + 1}/${chunks.length}] ${chunk.join(',')}: ${elements.length} found, ${places.size} total, ${minutes} min elapsed`);
      await sleep(3000); // be gentle with the volunteer-run servers
    }
  }

  // Guard against a quietly broken download wiping out good data.
  let previous = 0;
  try {
    previous = JSON.parse(await readFile(path.join(outDir, 'index.json'), 'utf8')).count || 0;
  } catch { /* first build */ }
  if (!force && places.size < previous * 0.8) {
    throw new Error(`Only ${places.size} places found, down from ${previous}. Re-run with --force if that is right.`);
  }

  const byTile = new Map();
  for (const place of places.values()) {
    const key = tileKeyFor(place.lat, place.lon);
    if (!byTile.has(key)) byTile.set(key, []);
    byTile.get(key).push(place);
  }

  const tmpDir = `${outDir}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const rows = {};
  for (const key of [...byTile.keys()].sort()) {
    const [y, x] = key.split('_').map(Number);
    (rows[y] ||= []).push(x);
    // One place per line, in a stable order, so weekly updates make small diffs.
    const lines = byTile.get(key)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((place) => JSON.stringify(packPlace(place)));
    await writeFile(path.join(tmpDir, `${key}.json`), `{"p":[\n${lines.join(',\n')}\n]}\n`);
  }
  for (const xs of Object.values(rows)) xs.sort((a, b) => a - b);
  const index = {
    version: 1,
    generated: now().toISOString(),
    tileDegrees: TILE_DEGREES,
    regions: regions.map((r) => r.bbox),
    count: places.size,
    rows,
  };
  await writeFile(path.join(tmpDir, 'index.json'), `${JSON.stringify(index)}\n`);
  await rm(outDir, { recursive: true, force: true });
  await rename(tmpDir, outDir);
  log(`Wrote ${places.size} places in ${byTile.size} tiles to ${outDir}`);
  return { count: places.size, tiles: byTile.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/data/tiles');
  buildData({ outDir, force: process.argv.includes('--force') }).catch((err) => {
    console.error(`Build failed, existing data left untouched: ${err.message}`);
    process.exit(1);
  });
}
