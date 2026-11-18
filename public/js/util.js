// Small pure helpers shared by the app and the tests.

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two lat/lon points. */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Eight-point compass direction ("N", "NE", ...) from the first point to the second. */
export function compass(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8];
}

/** Human-friendly distance: feet/miles for "mi", metres/kilometres for "km". */
export function formatDistance(metres, unit) {
  if (!Number.isFinite(metres)) return '';
  if (unit === 'mi') {
    const miles = metres / 1609.344;
    if (miles < 0.1) return `${Math.max(10, Math.round((metres * 3.28084) / 10) * 10)} ft`;
    return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
  }
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  const km = metres / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Miles for the few locales that use them, kilometres everywhere else. */
export function defaultUnit(locale) {
  const region = String(locale || '').split('-').pop().toUpperCase();
  return ['US', 'GB', 'LR', 'MM'].includes(region) ? 'mi' : 'km';
}

/** Parse a "#zoom/lat/lon" location hash; returns null when it isn't one. */
export function parseHash(hash) {
  const m = /^#?(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(hash || '');
  if (!m) return null;
  const zoom = Number(m[1]);
  const lat = Number(m[2]);
  const lon = Number(m[3]);
  if (zoom < 0 || zoom > 22 || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { zoom, lat, lon };
}

export function formatHash({ zoom, lat, lon }) {
  return `#${Math.round(zoom)}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
}
