/**
 * lib/services/ingest/track-place-match.ts — привязка трека к месту по имени
 * и близости.
 *
 * ── Откуда переехало (07.09) ──────────────────────────────────────────────
 *
 * Эти три вещи — сила совпадения имён, ссылка на место и сам матчер — жили в
 * `idilesom-importer.ts` рядом со скрейпером чужого сайта. Скрейпер удалён по
 * решению владельца («вычистить idilesom»), а помощники — нет: ими пользуются
 * посторонние вещи, к тому источнику отношения не имеющие:
 *   - `lib/services/data-repair.ts` — сверка и починка записей;
 *   - `lib/services/ingest/osm-traces-scout.ts` — треки OSM.
 *
 * Удалить их вместе со скрейпером значило бы снести чужую работу заодно с
 * своей; оставить их в модуле с именем конкурента — оставить имя. Поэтому
 * переезд, а не удаление, и модуль назван по тому, что он делает.
 *
 * Логика перенесена ДОСЛОВНО: пороги, нормализация имён и сэмплирование трека
 * те же самые. Правка смысла заодно с переездом — способ получить два
 * изменения под одним объяснением и не понять потом, какое из них сломало.
 */

/** Гео-приставки убираются до сравнения: «Вулкан Авача» ~ «Авачинский вулкан». */
const GEO_PREFIXES = /^(вулкан|гора|озеро|река|мыс|бухта|хребет|перевал|остров|долина|источник|водопад|пляж|ручей|пещера|ущелье)\s+/gi;

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(GEO_PREFIXES, '')
    .replace(/[^а-яa-z0-9\s-]/g, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim();
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Сила совпадения имён:
 *   strong — равенство/вхождение после нормализации («Озеро Курильское» ~
 *            «Курильское озеро») — можно доверять на большей дистанции;
 *   weak   — пересечение слов (ловит и типовые «термальные источники») —
 *            только рядом с треком.
 */
export function nameMatchStrength(a: string, b: string): 'strong' | 'weak' | null {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 'strong';
  // Short exact containment: "Авача" inside "Авачинский" or vice-versa
  if (na.length >= 5 && nb.startsWith(na.slice(0, 5))) return 'strong';
  if (nb.length >= 5 && na.startsWith(nb.slice(0, 5))) return 'strong';
  // Word overlap: ≥2 meaningful words in common
  const wordsA = na.split(' ').filter(w => w.length >= 4);
  const wordsB = new Set(nb.split(' ').filter(w => w.length >= 4));
  const overlap = wordsA.filter(w => wordsB.has(w)).length;
  if (overlap >= 2 || (wordsA.length === 1 && wordsB.size === 1 && wordsB.has(wordsA[0]))) return 'weak';
  return null;
}

export interface PlaceRef {
  ark_id: string;
  name: string;
  lat: number;
  lng: number;
}

// Порог дистанции зависит от силы совпадения имён: сильное («Озеро
// Курильское» ~ «Курильское озеро») доверяем до 12 км — у крупных объектов
// точка места (центр озера, вершина) легко дальше 5 км от берегового трека;
// слабое (пересечение слов, ловит типовые «термальные источники») — только 5.
const LINK_MAX_KM_WEAK = 5;
const LINK_MAX_KM_STRONG = 12;

/** Ближайшее по треку место с похожим именем; null если нет в пределах порога. */
export function matchTrackToPlace(
  track: { title: string; coordinates: number[][] },
  places: PlaceRef[],
): { place: PlaceRef; minKm: number } | null {
  const coords = track.coordinates.filter(c => Array.isArray(c) && c.length >= 2);
  if (coords.length === 0) return null;
  // Длинные треки сэмплируем: точность в сотни метров достаточна при км-порогах
  const step = Math.max(1, Math.floor(coords.length / 200));
  let best: { place: PlaceRef; minKm: number } | null = null;
  for (const pl of places) {
    const strength = nameMatchStrength(pl.name, track.title);
    if (!strength) continue;
    const maxKm = strength === 'strong' ? LINK_MAX_KM_STRONG : LINK_MAX_KM_WEAK;
    let minKm = Infinity;
    for (let i = 0; i < coords.length; i += step) {
      const d = haversineKm(pl.lat, pl.lng, coords[i][1], coords[i][0]);
      if (d < minKm) minKm = d;
    }
    const dLast = haversineKm(pl.lat, pl.lng, coords[coords.length - 1][1], coords[coords.length - 1][0]);
    if (dLast < minKm) minKm = dLast;
    if (minKm > maxKm) continue;
    if (!best || minKm < best.minKm) best = { place: pl, minKm };
  }
  return best;
}
