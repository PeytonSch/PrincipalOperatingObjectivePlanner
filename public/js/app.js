// POOP: the map UI. Leaflet is loaded as a classic script before this module.
import { PlaceStore, describePlace, osmUrl, MIN_ZOOM } from './data.js';
import { haversine, compass, formatDistance, defaultUnit, parseHash, formatHash } from './util.js';

const L = window.L;
const $ = (id) => document.getElementById(id);

const LIST_LIMIT = 40;
const LIST_RADIUS_M = 25000;
const LOCATE_ZOOM = 16;

// Static, trusted markup. Text that comes from OpenStreetMap is user-written
// and is only ever inserted with textContent.
const GLYPH = {
  toilet:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 3h3a1 1 0 0 1 1 1v9h-5V4a1 1 0 0 1 1-1zM11.7 10.5h7.6a1.25 1.25 0 0 1 0 2.5h-7.6a1.25 1.25 0 0 1 0-2.5zM4.5 14.2h15.6c-.5 2.6-2.2 4.4-4.6 5.2v2.1h-7v-2.4c-2.3-1-3.7-2.7-4-4.9z"/></svg>',
  water:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c3.2 4.2 6.5 7.9 6.5 11.9a6.5 6.5 0 0 1-13 0c0-4 3.3-7.7 6.5-11.9z"/></svg>',
};

// ---- preferences (localStorage may be unavailable in private modes) --------

let storage = null;
try {
  storage = window.localStorage;
  storage.getItem('poop:probe');
} catch {
  storage = null;
}
const prefs = {
  get(key, fallback) {
    try {
      const raw = storage?.getItem(`poop:${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { storage?.setItem(`poop:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

// ---- state -----------------------------------------------------------------

const store = new PlaceStore({ storage });
const filters = { toilet: true, water: true, ...prefs.get('filters', {}) };
let unit = prefs.get('unit', defaultUnit(navigator.language));
let user = null; // { lat, lon, acc }
let selectedId = null;
let loadState = null; // null | 'loading' | 'zoom' | 'error'
let notice = null;
const markers = new Map(); // place id -> Leaflet marker

const mapEl = $('map');
const sheet = $('sheet');
const wide = window.matchMedia('(min-width: 820px)');

// ---- map -------------------------------------------------------------------

const hashView = parseHash(location.hash);
const startView = hashView || prefs.get('view', null);

const map = L.map(mapEl, { zoomControl: false, worldCopyJump: true, minZoom: 2 });
map.attributionControl.setPrefix(false);
map.setView(startView ? [startView.lat, startView.lon] : [25, 0], startView ? startView.zoom : 2);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
  L.control.zoom({ position: 'bottomright' }).addTo(map);
}

const cluster = L.markerClusterGroup({
  maxClusterRadius: 46,
  disableClusteringAtZoom: 16,
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: false,
  chunkedLoading: true,
  iconCreateFunction: (c) =>
    L.divIcon({ className: 'cluster', html: `<span>${c.getChildCount()}</span>`, iconSize: [40, 40] }),
}).addTo(map);

function pinIcon(kind, selected) {
  return L.divIcon({
    className: `pin pin--${kind}${selected ? ' is-selected' : ''}`,
    html: `<span class="pin-body">${GLYPH[kind]}</span>`,
    iconSize: [34, 34],
  });
}

/** Bring the markers on the map in line with the store and the filters. */
function syncMarkers() {
  const add = [];
  const remove = [];
  for (const [id, marker] of markers) {
    const place = store.places.get(id);
    if (!place || !filters[place.kind]) {
      remove.push(marker);
      markers.delete(id);
    }
  }
  for (const place of store.places.values()) {
    if (!filters[place.kind] || markers.has(place.id)) continue;
    const marker = L.marker([place.lat, place.lon], {
      icon: pinIcon(place.kind, place.id === selectedId),
      title: describePlace(place).title,
    });
    marker.on('click', () => select(place.id, { fromMap: true }));
    markers.set(place.id, marker);
    add.push(marker);
  }
  if (remove.length) cluster.removeLayers(remove);
  if (add.length) cluster.addLayers(add);
  if (selectedId && !markers.has(selectedId)) closeDetail();
}

function highlight(id, on) {
  const marker = markers.get(id);
  const place = store.places.get(id);
  if (!marker || !place) return;
  marker.setIcon(pinIcon(place.kind, on));
  marker.setZIndexOffset(on ? 1000 : 0);
}

/** The visible area (slightly padded) as a plain, wrapped bounding box. */
function viewBounds() {
  const b = map.getBounds().pad(0.1);
  let w = b.getWest();
  let e = b.getEast();
  if (e - w >= 360) {
    w = -180;
    e = 180;
  } else {
    const shift = Math.floor((w + 180) / 360) * 360;
    w -= shift;
    e = Math.min(180, e - shift);
  }
  return { s: Math.max(-90, b.getSouth()), n: Math.min(90, b.getNorth()), w, e };
}

// ---- loading places --------------------------------------------------------

let inflight = null; // { keys: Set<string>, controller: AbortController }
let refreshTimer = 0;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 300);
}

async function refresh() {
  if (map.getZoom() < MIN_ZOOM) return finishRefresh('zoom');
  const bounds = viewBounds();
  const plan = store.plan(bounds);
  if (plan.hydrated) syncMarkers();
  if (plan.tooBig) return finishRefresh('zoom');
  const needed = [...plan.missing, ...plan.tiles.map((tile) => `tile:${tile}`)];
  if (!needed.length) return finishRefresh(null);

  // A request that already covers this view is on its way: let it finish.
  if (inflight && needed.every((key) => inflight.keys.has(key))) {
    setLoadState('loading');
    return render();
  }
  inflight?.controller.abort();
  const mine = { keys: new Set(needed), controller: new AbortController() };
  inflight = mine;
  setLoadState('loading');
  render();
  try {
    await store.ensure(bounds, { signal: mine.controller.signal });
    if (inflight !== mine) return;
    inflight = null;
    syncMarkers();
    refresh(); // the view may have moved on while we were waiting
  } catch (err) {
    if (inflight !== mine) return;
    inflight = null;
    console.warn('Could not load places:', err);
    setLoadState('error');
    render();
  }
}

function finishRefresh(state) {
  if (inflight) {
    inflight.controller.abort();
    inflight = null;
  }
  setLoadState(state);
  render();
}

// ---- status pill -----------------------------------------------------------

const STATUS_TEXT = {
  loading: 'Finding restrooms and water…',
  zoom: 'Zoom in to see restrooms and water',
  error: 'Couldn’t load places',
};
let noticeTimer = 0;

function setLoadState(state) {
  loadState = state;
  renderStatus();
}

function showNotice(text) {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = null;
    renderStatus();
  }, 7000);
  renderStatus();
}

function renderStatus() {
  const text = notice || STATUS_TEXT[loadState] || '';
  $('status').hidden = !text;
  $('status-text').textContent = text;
  $('status-retry').hidden = Boolean(notice) || loadState !== 'error';
}

$('status-retry').addEventListener('click', refresh);

// ---- list and detail -------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // static markup only
    else node.setAttribute(key, value);
  }
  node.append(...[].concat(children).filter(Boolean));
  return node;
}

/** Where distances are measured from: you, if you are on screen. */
function reference() {
  if (user && map.getBounds().pad(0.25).contains([user.lat, user.lon])) {
    return { lat: user.lat, lon: user.lon, mine: true };
  }
  const c = map.getCenter().wrap();
  return { lat: c.lat, lon: c.lng, mine: false };
}

function render() {
  renderList();
  if (selectedId) {
    const place = store.places.get(selectedId);
    if (place) renderDetail(place);
  }
}

function renderList() {
  const ref = reference();
  const rows = [];
  if (ref.mine || map.getZoom() >= MIN_ZOOM) {
    for (const place of store.places.values()) {
      if (!filters[place.kind]) continue;
      const d = haversine(ref.lat, ref.lon, place.lat, place.lon);
      if (d <= LIST_RADIUS_M) rows.push({ place, d, dir: compass(ref.lat, ref.lon, place.lat, place.lon) });
    }
    rows.sort((a, b) => a.d - b.d);
  }

  $('list-title').textContent = ref.mine ? 'Nearest to you' : 'Nearest to the map center';
  $('unit-button').textContent = unit;

  const list = $('places');
  list.replaceChildren(
    ...rows.slice(0, LIST_LIMIT).map(({ place, d, dir }) => {
      const info = describePlace(place);
      const button = el('button', { class: 'place', type: 'button' }, [
        el('span', { class: `place-icon place-icon--${place.kind}`, html: GLYPH[place.kind] }),
        el('span', { class: 'place-text' }, [
          el('span', { class: 'place-name', text: info.title }),
          el('span', { class: 'place-sub', text: info.summary || info.typeLabel }),
        ]),
        el('span', { class: 'place-dist' }, [
          formatDistance(d, unit),
          d > 15 ? el('span', { class: 'place-dir', text: dir }) : null,
        ]),
      ]);
      button.addEventListener('click', () => select(place.id));
      return el('li', {}, button);
    }),
  );

  const empty = $('empty');
  let message = '';
  if (!rows.length) {
    if (!filters.toilet && !filters.water) message = 'Turn on Restrooms or Water at the top to see places.';
    else if (loadState === 'zoom') message = 'Zoom in, or tap the locate button, to see restrooms and water fountains.';
    else if (loadState === 'loading') message = 'Looking for places…';
    else if (loadState === 'error') message = 'Couldn’t load places. Check your connection and tap Retry.';
    else message = 'Nothing is mapped near here yet. Know a spot? Tap POOP at the top to see how to add it.';
  }
  empty.textContent = message;
  const inDetail = sheet.dataset.view === 'detail';
  empty.hidden = inDetail || !message;
  list.hidden = inDetail;
}

function directionsUrl(place) {
  const dest = `${place.lat.toFixed(6)},${place.lon.toFixed(6)}`;
  const apple =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return apple
    ? `https://maps.apple.com/?daddr=${dest}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=walking`;
}

function renderDetail(place) {
  const info = describePlace(place);
  const metres = user ? haversine(user.lat, user.lon, place.lat, place.lon) : NaN;
  const distance = !user
    ? ''
    : metres > 15
      ? `${formatDistance(metres, unit)} ${compass(user.lat, user.lon, place.lat, place.lon)} of you`
      : 'Right here';
  const back = el('button', { class: 'back', type: 'button', text: '‹ All nearby' });
  back.addEventListener('click', closeDetail);

  const rows = [];
  const addRow = (label, value) => {
    if (value) rows.push(el('dt', { text: label }), el('dd', { text: value }));
  };
  addRow('Hours', info.hours);
  addRow('Run by', info.operator);
  addRow('Notes', info.description);

  const meta = el('p', { class: 'detail-meta' });
  if (distance) meta.append(el('strong', { text: distance }), ' · ');
  meta.append(info.typeLabel);

  const osm = osmUrl(place);
  const parts = [
    back,
    el('div', { class: 'detail-head' }, [
      el('span', { class: `place-icon place-icon--${place.kind}`, html: GLYPH[place.kind] }),
      el('div', {}, [el('h2', { text: info.title }), meta]),
    ]),
    info.facts.length
      ? el('ul', { class: 'facts' }, info.facts.map((f) => el('li', { class: `fact fact--${f.tone}`, text: f.text })))
      : null,
    rows.length ? el('dl', { class: 'info' }, rows) : null,
    el('div', { class: 'actions' }, [
      el('a', { class: 'button button--primary', href: directionsUrl(place), target: '_blank', rel: 'noopener', text: 'Directions' }),
      osm ? el('a', { class: 'button', href: osm, target: '_blank', rel: 'noopener', text: 'Fix details' }) : null,
    ]),
  ];
  $('detail').replaceChildren(...parts.filter(Boolean));
}

function select(id, { fromMap = false } = {}) {
  const place = store.places.get(id);
  if (!place) return;
  if (selectedId) highlight(selectedId, false);
  selectedId = id;
  highlight(id, true);
  renderDetail(place);
  sheet.dataset.view = 'detail';
  $('detail').hidden = false;
  $('places').hidden = true;
  $('empty').hidden = true;
  $('sheet-body').scrollTop = 0;

  // Keep the pin clear of the top bar and of the sheet covering the map.
  const target = L.latLng(place.lat, place.lon);
  const reveal = () => {
    const covered = wide.matches
      ? 0
      : Math.max(0, sheet.offsetHeight - (window.innerHeight - mapEl.getBoundingClientRect().bottom));
    map.panInside(target, { paddingTopLeft: [44, 120], paddingBottomRight: [44, covered + 44] });
  };
  if (fromMap) {
    reveal();
  } else {
    map.once('moveend', reveal);
    map.setView(target, Math.max(map.getZoom(), 16));
  }
}

function closeDetail() {
  if (selectedId) highlight(selectedId, false);
  selectedId = null;
  sheet.dataset.view = 'list';
  $('detail').hidden = true;
  $('detail').replaceChildren();
  renderList();
}

map.on('click', () => {
  if (selectedId) closeDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedId && !$('about').open) closeDetail();
});

// ---- bottom sheet (phones): tap or drag the grip to open and close ---------

const grip = $('sheet-grip');
let drag = null;
let pointerHandledAt = 0;

function setSheetState(state) {
  sheet.dataset.state = state;
  $('sheet-toggle').setAttribute('aria-expanded', String(state === 'open'));
  if (state === 'peek') $('sheet-body').scrollTop = 0;
}

/** How far down (px) the sheet sits when closed. */
function closedOffset() {
  const peek = window.innerHeight - mapEl.getBoundingClientRect().bottom + 20;
  return Math.max(0, sheet.offsetHeight - peek);
}

grip.addEventListener('pointerdown', (e) => {
  if (wide.matches || sheet.dataset.view === 'detail' || e.target.closest('.unit')) return;
  drag = {
    y: e.clientY,
    base: sheet.dataset.state === 'open' ? 0 : closedOffset(),
    max: closedOffset(),
    offset: null,
  };
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y;
  if (drag.offset === null && Math.abs(dy) < 6) return;
  sheet.classList.add('is-dragging');
  drag.offset = Math.min(drag.max, Math.max(0, drag.base + dy));
  sheet.style.transform = `translateY(${drag.offset}px)`;
});
const toggleSheet = () => setSheetState(sheet.dataset.state === 'open' ? 'peek' : 'open');
const endDrag = (e) => {
  if (!drag) return;
  if (drag.offset !== null) {
    const moved = drag.offset - drag.base;
    sheet.classList.remove('is-dragging');
    sheet.style.transform = '';
    if (moved < -30) setSheetState('open');
    else if (moved > 30) setSheetState('peek');
    pointerHandledAt = performance.now();
  } else if (e.type === 'pointerup') {
    toggleSheet(); // a plain tap on the grip
    pointerHandledAt = performance.now();
  }
  drag = null;
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// Keyboard and assistive-technology activation arrives as a bare click.
grip.addEventListener('click', (e) => {
  if (wide.matches || sheet.dataset.view === 'detail' || e.target.closest('.unit')) return;
  if (performance.now() - pointerHandledAt < 500) return; // already handled above
  toggleSheet();
});

$('unit-button').addEventListener('click', () => {
  unit = unit === 'mi' ? 'km' : 'mi';
  prefs.set('unit', unit);
  render();
});

wide.addEventListener('change', () => map.invalidateSize());

// ---- filters ---------------------------------------------------------------

for (const chip of document.querySelectorAll('.chip[data-filter]')) {
  const kind = chip.dataset.filter;
  chip.setAttribute('aria-pressed', String(filters[kind]));
  chip.addEventListener('click', () => {
    filters[kind] = !filters[kind];
    chip.setAttribute('aria-pressed', String(filters[kind]));
    prefs.set('filters', filters);
    syncMarkers();
    render();
  });
}

// ---- your location ---------------------------------------------------------

const fab = $('locate-button');
let watchId = null;
let recenterOnFix = false;
let userMarker = null;
let accuracyRing = null;
let lastRendered = null;

function locate({ recenter = true } = {}) {
  if (!('geolocation' in navigator)) {
    showNotice('This browser can’t share your location. Move the map instead.');
    return;
  }
  if (user && recenter) map.setView([user.lat, user.lon], Math.max(map.getZoom(), LOCATE_ZOOM));
  if (watchId !== null) return;
  recenterOnFix = recenter;
  fab.classList.add('is-busy');
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 15000,
    timeout: 20000,
  });
}

function onPosition(pos) {
  user = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
  prefs.set('geo', true);
  fab.classList.remove('is-busy');
  fab.classList.add('is-active');

  const at = [user.lat, user.lon];
  if (!userMarker) {
    accuracyRing = L.circle(at, {
      radius: user.acc, stroke: false, fillColor: '#2563eb', fillOpacity: 0.12, interactive: false,
    }).addTo(map);
    userMarker = L.marker(at, {
      icon: L.divIcon({ className: 'user-dot', html: '<span></span>', iconSize: [20, 20] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 2000,
    }).addTo(map);
  } else {
    userMarker.setLatLng(at);
    accuracyRing.setLatLng(at).setRadius(user.acc);
  }

  if (recenterOnFix) {
    recenterOnFix = false;
    lastRendered = user;
    map.setView(at, Math.max(map.getZoom(), LOCATE_ZOOM)); // moveend re-renders
    return;
  }
  // Re-sort the list once you have moved a few strides.
  if (!lastRendered || haversine(lastRendered.lat, lastRendered.lon, user.lat, user.lon) > 8) {
    lastRendered = user;
    render();
  }
}

function onPositionError(err) {
  fab.classList.remove('is-busy');
  if (err.code === err.PERMISSION_DENIED) {
    prefs.set('geo', false);
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    showNotice('Location is blocked. Allow it in your browser settings, or move the map yourself.');
  } else if (!user) {
    showNotice('Couldn’t find your location yet. Still trying…');
  }
}

fab.addEventListener('click', () => locate());

// ---- map movement, shareable URL ------------------------------------------

map.on('moveend', () => {
  const c = map.getCenter().wrap();
  const view = { zoom: map.getZoom(), lat: c.lat, lon: c.lng };
  prefs.set('view', view);
  try { history.replaceState(null, '', formatHash(view)); } catch { /* ignore */ }
  renderList();
  scheduleRefresh();
});

window.addEventListener('hashchange', () => {
  const view = parseHash(location.hash);
  if (view && formatHash(view) !== formatHash({ zoom: map.getZoom(), lat: map.getCenter().lat, lon: map.getCenter().lng })) {
    map.setView([view.lat, view.lon], view.zoom);
  }
});

// ---- about and welcome -----------------------------------------------------

$('about-button').addEventListener('click', () => $('about').showModal());
$('about').addEventListener('click', (e) => {
  if (e.target === $('about')) $('about').close(); // tap on the backdrop
});

$('welcome-locate').addEventListener('click', () => {
  $('welcome').hidden = true;
  locate();
});
$('welcome-browse').addEventListener('click', () => {
  $('welcome').hidden = true;
});

async function locationAlreadyAllowed() {
  if (prefs.get('geo', false)) return true;
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

// ---- start -----------------------------------------------------------------

render();
store.loadIndex().then(refresh); // static tiles where we have them, live data elsewhere

fetch('data/community.json')
  .then((res) => (res.ok ? res.json() : []))
  .then((entries) => {
    if (store.addCommunity(entries)) {
      syncMarkers();
      render();
    }
  })
  .catch(() => { /* the community list is optional */ });

locationAlreadyAllowed().then((allowed) => {
  // A shared link (#zoom/lat/lon) wins over jumping to your own location.
  if (allowed) locate({ recenter: !hashView });
  else if (!startView) $('welcome').hidden = false;
});
