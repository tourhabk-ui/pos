/**
 * lib/services/geocode.ts
 *
 * Геокодинг через Nominatim (OpenStreetMap) — бесплатно, без ключа. Usage
 * policy Nominatim: максимум 1 запрос/сек, обязательный User-Agent,
 * не для тяжёлого bulk-использования (см. operations.osmfoundation.org/policies/nominatim).
 * Подходит для точечных админ-действий (геокодинг одного места по запросу),
 * не для массового импорта.
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'KamchatourHub/1.0 (https://tourhab.ru; admin geocoding tool)';

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

// Kamchatka bounding box (см. lib/services/idilesom-importer.ts) — защита от
// того, что Nominatim примет название места за что-то за пределами края.
export const KAMCHATKA_BOUNDS = { latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 };

export function withinKamchatka(lat: number, lng: number): boolean {
  return lat >= KAMCHATKA_BOUNDS.latMin && lat <= KAMCHATKA_BOUNDS.latMax
    && lng >= KAMCHATKA_BOUNDS.lngMin && lng <= KAMCHATKA_BOUNDS.lngMax;
}

export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const q = query.trim();
  if (!q) return null;

  try {
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const data = await res.json() as Array<{ lat: string; lon: string; display_name: string }>;
    const first = data[0];
    if (!first) return null;

    const lat = parseFloat(first.lat);
    const lng = parseFloat(first.lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

    return { lat, lng, displayName: first.display_name };
  } catch {
    return null;
  }
}
