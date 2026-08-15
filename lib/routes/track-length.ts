/**
 * lib/routes/track-length.ts — измерения по треку маршрута.
 *
 * Нужны для дооформления записей, пришедших с idilesom: у них есть
 * снятый трек, но пустые метаданные — ни дистанции, ни связи с местом.
 * Дистанцию считаем ИЗ ТРЕКА (это факт, а не оценка), место привязываем
 * только если трек действительно проходит рядом с ним.
 *
 * Координаты — в порядке GeoJSON: [lng, lat].
 */

const KM_PER_DEG_LAT = 111.32;

/** Расстояние между двумя точками, км. Плоская проекция: для Камчатки её точности с запасом хватает на звеньях трека. */
function segmentKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const midLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  return Math.hypot(
    (aLat - bLat) * KM_PER_DEG_LAT,
    (aLng - bLng) * KM_PER_DEG_LAT * Math.cos(midLat),
  );
}

export type Coord = [number, number]; // [lng, lat]

/** Длина ломаной, км (округление до 0.1). */
export function trackLengthKm(coords: Coord[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [aLng, aLat] = coords[i - 1];
    const [bLng, bLat] = coords[i];
    total += segmentKm(aLat, aLng, bLat, bLng);
  }
  return Math.round(total * 10) / 10;
}

/** Насколько близко трек подходит к точке, км. */
export function nearestVertexKm(coords: Coord[], lat: number, lng: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const [cLng, cLat] of coords) {
    const d = segmentKm(lat, lng, cLat, cLng);
    if (d < best) best = d;
  }
  return Math.round(best * 10) / 10;
}

/**
 * Пределы вменяемости для дистанции, посчитанной из трека.
 *
 * Нижний: тропа короче двухсот метров — не маршрут, а обрывок импорта.
 * Верхний: у пешего маршрута к одному объекту не бывает трёхсот
 * километров; такая длина означает склеенную паутину или битые
 * координаты (у «Озера Икар» трек лежит в 337 км от самого озера).
 */
const MIN_SANE_KM = 0.2;
const MAX_SANE_KM = 200;

/** Дальше этого трек не про это место, и привязывать его нельзя. */
const MAX_PLACE_OFFSET_KM = 5;

export interface EnrichFacts {
  lengthKm: number;
  placeOffsetKm: number | null;
  vertexCount: number;
}

export interface EnrichVerdict {
  writeDistance: boolean;
  linkPlace: boolean;
  notes: string[];
}

/**
 * Что можно сделать с записью: посчитанная дистанция и привязка места
 * решаются ОТДЕЛЬНО. Трек бывает вменяемым по длине, но проложенным
 * далеко от места-тёзки — тогда дистанция правда, а связь ложь.
 */
export function enrichVerdict(f: EnrichFacts): EnrichVerdict {
  const notes: string[] = [];
  let writeDistance = true;
  let linkPlace = true;

  if (f.vertexCount < 5) {
    notes.push(`вершин всего ${f.vertexCount} — это не трек`);
    writeDistance = false; linkPlace = false;
  }
  if (f.lengthKm < MIN_SANE_KM) {
    notes.push(`длина ${f.lengthKm} км — обрывок, не маршрут`);
    writeDistance = false; linkPlace = false;
  }
  if (f.lengthKm > MAX_SANE_KM) {
    notes.push(`длина ${f.lengthKm} км — склейка или битые координаты`);
    writeDistance = false; linkPlace = false;
  }
  if (f.placeOffsetKm == null) {
    notes.push('у места нет координат — близость не проверить');
    linkPlace = false;
  } else if (f.placeOffsetKm > MAX_PLACE_OFFSET_KM) {
    notes.push(`трек проходит в ${f.placeOffsetKm} км от места — он не про него`);
    linkPlace = false;
  }

  return { writeDistance, linkPlace, notes };
}
