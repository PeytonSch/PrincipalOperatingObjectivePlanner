// Run with: npm test   (uses Node's built-in test runner, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PlaceStore, buildQuery, cellsForBounds, describePlace, normalizeCommunity, normalizeElement, osmUrl,
} from '../public/js/data.js';
import { compass, defaultUnit, formatDistance, formatHash, haversine, parseHash } from '../public/js/util.js';

const BOUNDS = { s: 40.771, w: -73.979, n: 40.779, e: -73.971 }; // inside one grid cell

const node = (id, lat, lon, tags) => ({ type: 'node', id, lat, lon, tags });
const TOILET = node(1, 40.775, -73.975, { amenity: 'toilets', fee: 'no', wheelchair: 'yes', opening_hours: '24/7' });
const FOUNTAIN = node(2, 40.776, -73.974, { amenity: 'drinking_water', bottle: 'yes', man_made: 'water_tap' });

function fakeStorage() {
  const data = new Map();
  return {
    data,
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, query: init.body.get('data') });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { ok: next.status === undefined || next.status === 200, status: next.status ?? 200, json: async () => next.body };
  };
  return { impl, calls };
}

test('distance helpers', () => {
  const d = haversine(40.7712, -73.9742, 40.7812, -73.9742);
  assert.ok(Math.abs(d - 1112) < 5, `one hundredth of a degree of latitude is about 1.1 km, got ${d}`);
  assert.equal(compass(40, -74, 41, -74), 'N');
  assert.equal(compass(40, -74, 40, -73), 'E');
  assert.equal(compass(40, -74, 39, -75), 'SW');
  assert.equal(formatDistance(60, 'mi'), '200 ft');
  assert.equal(formatDistance(800, 'mi'), '0.5 mi');
  assert.equal(formatDistance(450, 'km'), '450 m');
  assert.equal(formatDistance(1234, 'km'), '1.2 km');
  assert.equal(defaultUnit('en-US'), 'mi');
  assert.equal(defaultUnit('de-DE'), 'km');
});

test('location hash round-trips and rejects junk', () => {
  const view = { zoom: 16, lat: 40.7712, lon: -73.9742 };
  assert.deepEqual(parseHash(formatHash(view)), view);
  assert.equal(parseHash('#about'), null);
  assert.equal(parseHash('#16/95/0'), null);
});

test('normalizeElement classifies and filters', () => {
  assert.equal(normalizeElement(TOILET).kind, 'toilet');
  assert.equal(normalizeElement(FOUNTAIN).kind, 'water');
  const way = { type: 'way', id: 9, center: { lat: 1, lon: 2 }, tags: { amenity: 'toilets' } };
  assert.deepEqual({ id: normalizeElement(way).id, lat: normalizeElement(way).lat }, { id: 'w9', lat: 1 });
  assert.equal(normalizeElement(node(3, 1, 2, { amenity: 'toilets', access: 'private' })), null);
  assert.equal(normalizeElement(node(4, 1, 2, { amenity: 'water_point', drinking_water: 'no' })), null);
  assert.equal(normalizeElement(node(5, 1, 2, { amenity: 'cafe' })), null);
  assert.equal(normalizeElement({ type: 'way', id: 6, tags: { amenity: 'toilets' } }), null, 'no coordinates');
});

test('describePlace turns tags into plain-language facts', () => {
  const toilet = describePlace(normalizeElement(TOILET));
  assert.equal(toilet.title, 'Public restroom');
  assert.deepEqual(toilet.facts.map((f) => f.text), ['Open 24/7', 'Free', 'Wheelchair accessible']);
  const fountain = describePlace(normalizeElement(FOUNTAIN));
  assert.equal(fountain.title, 'Water fountain');
  assert.ok(fountain.facts.some((f) => f.text === 'Bottle filler'));
  const named = describePlace(normalizeElement(node(7, 1, 2, { amenity: 'toilets', name: 'Boathouse', access: 'customers', fee: 'yes', charge: '$1' })));
  assert.equal(named.title, 'Boathouse');
  assert.deepEqual(named.facts.map((f) => f.text), ['Customers only', 'Fee: $1']);
});

test('community entries are validated', () => {
  const ok = normalizeCommunity({ id: 'shop', kind: 'water', lat: 40.7, lon: -74, name: 'Run shop', notes: 'Ask inside' }, 0);
  assert.equal(ok.id, 'cshop');
  assert.equal(osmUrl(ok), null);
  assert.equal(describePlace(ok).facts[0].text, 'Added by our community');
  assert.equal(normalizeCommunity({ kind: 'bench', lat: 1, lon: 2 }, 0), null);
  assert.equal(normalizeCommunity({ kind: 'water', lat: 'x', lon: 2 }, 0), null);
  assert.equal(osmUrl(normalizeElement(TOILET)), 'https://www.openstreetmap.org/node/1');
});

test('grid cells and query', () => {
  assert.equal(cellsForBounds(BOUNDS).length, 1);
  assert.equal(cellsForBounds({ s: 40.74, w: -74.01, n: 40.81, e: -73.94 }).length, 9);
  assert.equal(cellsForBounds({ s: 10, w: -20, n: 30, e: 20 }), null, 'huge areas are refused');
  const q = buildQuery({ s: 40.75, w: -74, n: 40.8, e: -73.95 });
  assert.match(q, /\[bbox:40\.75000,-74\.00000,40\.80000,-73\.95000\]/);
  assert.match(q, /"amenity"="toilets"/);
  assert.match(q, /"amenity"="drinking_water"/);
});

test('store fetches once per area, then serves from memory', async () => {
  const { impl, calls } = fakeFetch([{ body: { elements: [TOILET, FOUNTAIN] } }]);
  const store = new PlaceStore({ fetchImpl: impl });
  assert.deepEqual(await store.ensure(BOUNDS), { changed: true, tooBig: false });
  assert.equal(store.places.size, 2);
  assert.match(calls[0].query, /\[bbox:40\.75000,-74\.00000,40\.80000,-73\.95000\]/, 'whole cells are requested');
  assert.deepEqual(await store.ensure(BOUNDS), { changed: false, tooBig: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(await store.ensure({ s: 0, w: 0, n: 40, e: 40 }), { changed: false, tooBig: true });
});

test('store falls back to the next Overpass server and remembers it', async () => {
  const { impl, calls } = fakeFetch([{ status: 504 }, new Error('offline'), { body: { elements: [TOILET] } }]);
  const store = new PlaceStore({ fetchImpl: impl, endpoints: ['https://a', 'https://b', 'https://c'] });
  await store.ensure(BOUNDS);
  assert.deepEqual(calls.map((c) => c.url), ['https://a', 'https://b', 'https://c']);
  assert.equal(store.endpoints[0], 'https://c');
  assert.equal(store.places.size, 1);
});

test('store rejects when every server fails, and can retry', async () => {
  const { impl } = fakeFetch([{ status: 429 }, { status: 429 }, { body: { remark: 'runtime error: timed out', elements: [] } }, { body: { elements: [TOILET] } }]);
  const store = new PlaceStore({ fetchImpl: impl, endpoints: ['https://a', 'https://b', 'https://c'] });
  await assert.rejects(store.ensure(BOUNDS));
  assert.equal(store.places.size, 0);
  await store.ensure(BOUNDS);
  assert.equal(store.places.size, 1);
});

test('cache: fresh cells skip the network, stale cells show at once and refresh', async () => {
  const storage = fakeStorage();
  let now = 1_000_000_000_000;
  const first = fakeFetch([{ body: { elements: [TOILET, FOUNTAIN] } }]);
  await new PlaceStore({ fetchImpl: first.impl, storage, now: () => now }).ensure(BOUNDS);
  assert.equal(storage.data.size, 1);

  now += 60 * 60 * 1000; // an hour later, new page load
  const second = fakeFetch([new Error('should not be called')]);
  const store2 = new PlaceStore({ fetchImpl: second.impl, storage, now: () => now });
  assert.deepEqual(await store2.ensure(BOUNDS), { changed: true, tooBig: false });
  assert.equal(store2.places.size, 2);
  assert.equal(second.calls.length, 0);

  now += 5 * 24 * 60 * 60 * 1000; // five days later: stale, the fountain was removed
  const third = fakeFetch([{ body: { elements: [TOILET] } }]);
  const store3 = new PlaceStore({ fetchImpl: third.impl, storage, now: () => now });
  const plan = store3.plan(BOUNDS);
  assert.equal(plan.hydrated, true);
  assert.equal(store3.places.size, 2, 'stale data is shown while refreshing');
  await store3.ensure(BOUNDS);
  assert.deepEqual([...store3.places.keys()], ['n1'], 'deleted places disappear after the refresh');

  now += 40 * 24 * 60 * 60 * 1000; // far too old: ignored entirely
  const store4 = new PlaceStore({ fetchImpl: fakeFetch([new Error('offline')]).impl, storage, now: () => now });
  await assert.rejects(store4.ensure(BOUNDS));
  assert.equal(store4.places.size, 0);
});

test('cache survives a full localStorage', async () => {
  const storage = fakeStorage();
  storage.setItem('poop:cell:v1:1:1', JSON.stringify({ t: 1, p: [] }));
  storage.setItem('poop:cell:v1:2:2', JSON.stringify({ t: 2, p: [] }));
  storage.setItem('poop:unit', '"km"');
  const realSet = storage.setItem;
  let failures = 1;
  storage.setItem = (k, v) => { if (failures-- > 0) throw new Error('QuotaExceededError'); realSet(k, v); };
  const store = new PlaceStore({ fetchImpl: fakeFetch([{ body: { elements: [TOILET] } }]).impl, storage, now: () => 10 });
  await store.ensure(BOUNDS);
  assert.equal(storage.getItem('poop:cell:v1:1:1'), null, 'the oldest cell was evicted');
  assert.equal(storage.getItem('poop:unit'), '"km"', 'preferences are never evicted');
  assert.equal(store.places.size, 1);
});

test('community places survive a refresh of their area', async () => {
  const store = new PlaceStore({ fetchImpl: fakeFetch([{ body: { elements: [TOILET] } }]).impl });
  assert.equal(store.addCommunity([{ id: 'a', kind: 'water', lat: 40.7751, lon: -73.9751, name: 'Shop tap' }, { kind: 'nope' }]), 1);
  await store.ensure(BOUNDS);
  assert.deepEqual([...store.places.keys()].sort(), ['ca', 'n1']);
});
