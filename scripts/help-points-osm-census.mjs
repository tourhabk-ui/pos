#!/usr/bin/env node
/**
 * Перепись «точек помощи» края по выгрузке OpenStreetMap. Только чтение.
 *
 * Повод (10.11, #2930): владелец на вопрос «делать ли ближайшие точки в SOS?»
 * ответил «да». Готового списка приютов, кордонов и медпунктов с координатами
 * у платформы нет, поэтому первый шаг — посчитать, что знает открытая карта:
 * сколько таких объектов, у скольких есть имя и телефон и как далеко они от
 * города. По числам решается, годится ли карта источником.
 *
 * Чего перепись НЕ говорит:
 *  - что точка работает, открыта и там есть люди: OSM этого не знает;
 *  - что точка «безопасная». Это слово здесь не используется — за него нечем
 *    ответить (тот же довод, по которому снят «Безопасный» режим, #3208);
 *  - сколько учреждений: считаются объекты карты, одно учреждение может быть
 *    нарисовано дважды (точкой и зданием).
 *
 * Запуск: node scripts/help-points-osm-census.mjs <in.geojsonseq> [подпись области]
 * Вход — `osmium export -f geojsonseq -u type_id`. Ничего не пишет, кроме вывода.
 * Ноль объектов или битые строки — выход 1: это поломка выгрузки, а не пустой
 * край (CLAUDE.md §4.0).
 *
 * Второй режим — граница края одним контуром:
 *   node scripts/help-points-osm-census.mjs --boundary <in.geojsonseq> <out.geojson>
 * Зачем он. Первая редакция отдавала `osmium extract -p` файл со всеми
 * контурами разом — край, районы, поселения. Вложенные контуры osmium считает
 * по чёт-нечет: точка внутри края И района выпадала. Вырезка молча потеряла
 * Петропавловск, Вилючинск, Мильково и ещё полсотни сёл и при этом называлась
 * «граница края» (найдено 10.11 сверкой с рамкой). Теперь контур один, а сама
 * перепись требует контрольные сёла (CONTROL_SETTLEMENTS): нет хотя бы одного —
 * вырезка неполна, прогон красный.
 */
import { createReadStream, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Роды точек — в порядке вывода. `listed` — печатать ли объекты поимённо. */
export const KINDS = Object.freeze([
  { key: 'rescue', label: 'спасатели (emergency=mountain_rescue, rescue_station, water_rescue, ses_station)', listed: true },
  { key: 'medical', label: 'медицина (больница, поликлиника, врач, ФАП, станция скорой)', listed: false },
  { key: 'fire', label: 'пожарные части (amenity=fire_station)', listed: false },
  { key: 'police', label: 'полиция (amenity=police)', listed: false },
  { key: 'ranger', label: 'кордоны (amenity=ranger_station)', listed: true },
  { key: 'hut', label: 'приюты и избы (tourism=alpine_hut, wilderness_hut)', listed: true },
  { key: 'shelter', label: 'укрытия (amenity=shelter, кроме остановок транспорта)', listed: true },
  { key: 'phone', label: 'экстренные телефоны (emergency=phone)', listed: true },
  { key: 'camp', label: 'турстоянки и кемпинги (tourism=camp_site)', listed: false },
  { key: 'settlement', label: 'населённые пункты (place=city, town, village, hamlet; только точки)', listed: false },
]);

const RESCUE = new Set(['mountain_rescue', 'rescue_station', 'water_rescue', 'ses_station']);
const MEDICAL_AMENITY = new Set(['hospital', 'clinic', 'doctors']);
const MEDICAL_HEALTHCARE = new Set(['hospital', 'clinic', 'doctor', 'centre', 'paramedic']);
const HUT = new Set(['alpine_hut', 'wilderness_hut']);
const SETTLEMENT = new Set(['city', 'town', 'village', 'hamlet']);

/**
 * Каждый тег, по которому `classify` узнаёт точку: ключ, значение и род.
 * По этому списку сторож сверяет фильтр `osmium tags-filter` в workflow: тег,
 * который читает скрипт, но не пропускает фильтр, давал бы вечный ноль.
 */
export const READ_TAGS = Object.freeze([
  ...[...RESCUE].map((v) => ({ key: 'emergency', value: v, kind: 'rescue' })),
  ...[...MEDICAL_AMENITY].map((v) => ({ key: 'amenity', value: v, kind: 'medical' })),
  ...[...MEDICAL_HEALTHCARE].map((v) => ({ key: 'healthcare', value: v, kind: 'medical' })),
  { key: 'emergency', value: 'ambulance_station', kind: 'medical' },
  { key: 'amenity', value: 'fire_station', kind: 'fire' },
  { key: 'amenity', value: 'police', kind: 'police' },
  { key: 'amenity', value: 'ranger_station', kind: 'ranger' },
  ...[...HUT].map((v) => ({ key: 'tourism', value: v, kind: 'hut' })),
  { key: 'amenity', value: 'shelter', kind: 'shelter' },
  { key: 'emergency', value: 'phone', kind: 'phone' },
  { key: 'tourism', value: 'camp_site', kind: 'camp' },
  ...[...SETTLEMENT].map((v) => ({ key: 'place', value: v, kind: 'settlement' })),
]);

/** Центр Петропавловска-Камчатского: от него меряются полосы удалённости. */
export const CITY = Object.freeze({ lat: 53.02, lng: 158.65 });
/** Полосы: агломерация (Елизово, Вилючинск, Паратунка), дорожная сеть, глушь. */
export const BANDS = Object.freeze([
  { key: 'near', label: 'до 50 км от Петропавловска', maxKm: 50 },
  { key: 'mid', label: '50–200 км', maxKm: 200 },
  { key: 'far', label: 'дальше 200 км', maxKm: Infinity },
]);

/**
 * Контрольные населённые пункты: по одному на каждый край карты — город, юг,
 * запад, восток, север, Командоры. Есть все — вырезка покрыла край. Нет хоть
 * одного — она неполна, и нулям в таблице верить нельзя.
 */
export const CONTROL_SETTLEMENTS = Object.freeze([
  'Петропавловск-Камчатский', 'Озерновский', 'Усть-Хайрюзово', 'Усть-Камчатск', 'Палана', 'Тиличики', 'Никольское',
]);

/** Код региона, чей контур берётся границей. */
export const REGION_ISO = 'RU-KAM';

/** Сколько объектов печатать поимённо; остаток называется числом. */
export const LIST_LIMIT = 400;

/**
 * Род объекта по тегам или null. Порядок проверок — от «помощь придёт» к
 * «рядом есть люди»: объект с двумя подходящими тегами считается один раз.
 * Остановка транспорта (shelter_type=public_transport) — не укрытие в поле:
 * исход `transit`, в переписи он стоит отдельной строкой «отброшено».
 */
export function classify(tags, id = '') {
  if (!tags || typeof tags !== 'object') return null;
  const { emergency, amenity, healthcare, tourism, place } = tags;
  if (RESCUE.has(emergency)) return 'rescue';
  if (MEDICAL_AMENITY.has(amenity) || emergency === 'ambulance_station' || MEDICAL_HEALTHCARE.has(healthcare)) return 'medical';
  if (amenity === 'fire_station') return 'fire';
  if (amenity === 'police') return 'police';
  if (amenity === 'ranger_station') return 'ranger';
  if (HUT.has(tourism)) return 'hut';
  if (amenity === 'shelter') return tags.shelter_type === 'public_transport' ? 'transit' : 'shelter';
  if (emergency === 'phone') return 'phone';
  if (tourism === 'camp_site') return 'camp';
  // Населённый пункт на карте часто и точка, и контур: считаем только точки,
  // иначе одно село вошло бы дважды.
  if (SETTLEMENT.has(place) && String(id).startsWith('n')) return 'settlement';
  return null;
}

/** Середина охвата геометрии — как `out center` у Overpass. */
export function centerOf(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  let minLat = Infinity; let maxLat = -Infinity; let minLng = Infinity; let maxLng = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const [lng, lat] = c;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      return;
    }
    for (const part of c) walk(part);
  };
  walk(geometry.coordinates);
  if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) return null;
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}

export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bandOf(km) {
  return BANDS.find((b) => km <= b.maxKm).key;
}

/**
 * Один объект карты — один ключ. `osmium export` отдаёт замкнутую линию дважды:
 * линией (`w11`) и площадью (`a22`, номер = 2 × номер линии; у отношения —
 * 2 × номер + 1). Без сведения больница-здание считалась бы два раза.
 */
export function canonicalId(id) {
  const m = /^a(\d+)$/.exec(String(id ?? ''));
  if (!m) return String(id ?? '');
  const n = Number(m[1]);
  return n % 2 === 0 ? `w${n / 2}` : `r${(n - 1) / 2}`;
}

const hasPhone = (tags) => Boolean(tags.phone || tags['contact:phone'] || tags['contact:mobile']);
const nameOf = (tags) => tags['name:ru'] || tags.name || '';

/** Пустой итог: все роды с нулями — чтобы «ноль» был виден строкой, а не пропуском. */
export function emptyCensus() {
  const byKind = {};
  for (const k of KINDS) {
    byKind[k.key] = { count: 0, named: 0, phone: 0, bands: Object.fromEntries(BANDS.map((b) => [b.key, 0])) };
  }
  return {
    lines: 0, broken: 0, noGeometry: 0, transit: 0, repeats: 0, matched: 0,
    byKind, shelterTypes: {}, list: [], seen: new Set(), settlements: new Set(),
  };
}

/** Учесть один объект выгрузки (GeoJSON Feature). Возвращает род или null. */
export function addFeature(result, feature) {
  const tags = feature?.properties;
  const kind = classify(tags, feature?.id);
  if (!kind) return null;
  const key = canonicalId(feature?.id);
  if (key) {
    if (result.seen.has(key)) { result.repeats += 1; return null; }
    result.seen.add(key);
  }
  if (kind === 'transit') { result.transit += 1; return kind; }
  const center = centerOf(feature.geometry);
  if (!center) { result.noGeometry += 1; return null; }
  const slot = result.byKind[kind];
  const name = nameOf(tags);
  const km = distanceKm(CITY, center);
  slot.count += 1;
  if (name) slot.named += 1;
  if (hasPhone(tags)) slot.phone += 1;
  slot.bands[bandOf(km)] += 1;
  result.matched += 1;
  if (kind === 'settlement' && name) result.settlements.add(name);
  if (kind === 'shelter') {
    const t = tags.shelter_type || 'не указан';
    result.shelterTypes[t] = (result.shelterTypes[t] || 0) + 1;
  }
  if (KINDS.find((k) => k.key === kind).listed) {
    result.list.push({ kind, name, lat: center.lat, lng: center.lng, km, id: key });
  }
  return kind;
}

/** Каких контрольных сёл в переписи нет. Пусто — вырезка покрыла край. */
export function missingControl(result) {
  return CONTROL_SETTLEMENTS.filter((name) => !result.settlements.has(name));
}

/**
 * Контур региона из `osmium export --geometry-types=polygon`: одна запись с
 * нужным кодом ISO3166-2. Районы и поселения из того же файла не берутся —
 * вложенные контуры вырезка считает по чёт-нечет.
 * Исходы: { feature } — нашёлся ровно один; { reason } — нет, несколько или
 * файл не читается.
 */
export async function pickBoundary(lines, iso = REGION_ISO) {
  const found = [];
  let broken = 0;
  for await (const raw of lines) {
    const line = String(raw).replace(/^\x1e/, '').trim();
    if (!line) continue;
    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      broken += 1;
      continue;
    }
    const type = feature?.geometry?.type;
    if (feature?.properties?.['ISO3166-2'] === iso && (type === 'Polygon' || type === 'MultiPolygon')) found.push(feature);
  }
  if (broken > 0) return { reason: `нечитаемых строк: ${broken}` };
  if (found.length === 0) return { reason: `контура ${iso} в выгрузке нет` };
  if (found.length > 1) return { reason: `контуров ${iso} несколько: ${found.length}` };
  const { geometry } = found[0];
  return { feature: { type: 'Feature', properties: { 'ISO3166-2': iso }, geometry } };
}

/** Строки отчёта. Числа — из итога, слова о том, чего перепись не знает, — всегда. */
export function formatReport(result, areaLabel) {
  const out = [];
  out.push(`Область: ${areaLabel}.`);
  out.push(`Строк выгрузки: ${result.lines}, из них точек помощи: ${result.matched}. Остановок транспорта отброшено: ${result.transit}.`);
  if (result.repeats > 0) out.push(`Повторов одного объекта (линия и площадь) сведено: ${result.repeats}.`);
  if (result.noGeometry > 0) out.push(`Без координат (геометрия не разобрана): ${result.noGeometry} — в счёт не вошли.`);
  out.push('');
  out.push('Род | объектов | с именем | с телефоном | до 50 км | 50–200 км | дальше 200 км');
  for (const k of KINDS) {
    const s = result.byKind[k.key];
    out.push(`${k.label} | ${s.count} | ${s.named} | ${s.phone} | ${s.bands.near} | ${s.bands.mid} | ${s.bands.far}`);
  }
  const types = Object.entries(result.shelterTypes).sort((a, b) => b[1] - a[1]);
  if (types.length > 0) {
    out.push('');
    out.push(`Укрытия по shelter_type: ${types.map(([t, n]) => `${t} ${n}`).join(', ')}.`);
  }
  out.push('');
  const sorted = [...result.list].sort((a, b) => a.kind.localeCompare(b.kind) || a.km - b.km);
  out.push(`Поимённо (спасатели, кордоны, приюты, укрытия, телефоны): ${sorted.length}.`);
  for (const p of sorted.slice(0, LIST_LIMIT)) {
    out.push(`${p.kind} | ${p.name || 'без имени'} | ${p.lat.toFixed(3)}, ${p.lng.toFixed(3)} | ${Math.round(p.km)} км | ${p.id}`);
  }
  if (sorted.length > LIST_LIMIT) out.push(`…и ещё ${sorted.length - LIST_LIMIT} — не напечатаны, в счёте выше они есть.`);
  const lost = missingControl(result);
  out.push('');
  out.push(lost.length === 0
    ? `Контроль вырезки: все ${CONTROL_SETTLEMENTS.length} контрольных населённых пунктов на месте.`
    : `Контроль вырезки НЕ пройден: нет ${lost.join(', ')} — вырезка неполна, числам выше верить нельзя.`);
  out.push('');
  out.push('Чего здесь нет: работает ли точка и есть ли там люди — карта этого не знает. Считаются объекты карты, не учреждения.');
  return out;
}

/** Читает выгрузку построчно: файл края на сотни тысяч строк в память не берётся. */
export async function readCensus(lines) {
  const result = emptyCensus();
  for await (const raw of lines) {
    // geojsonseq (RFC 8142) начинает запись символом RS.
    const line = String(raw).replace(/^\x1e/, '').trim();
    if (!line) continue;
    result.lines += 1;
    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      result.broken += 1;
      continue;
    }
    addFeature(result, feature);
  }
  return result;
}

export async function main({
  argv = process.argv.slice(2),
  log = (s) => process.stdout.write(`${s}\n`),
  error = (s) => process.stderr.write(`${s}\n`),
  open = (path) => createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity }),
} = {}) {
  if (argv[0] === '--boundary') {
    const [, from, to] = argv;
    if (!from || !to) {
      error('Нужно: node scripts/help-points-osm-census.mjs --boundary <in.geojsonseq> <out.geojson>');
      return 2;
    }
    if (!existsSync(from)) {
      error(`Файла контуров нет: ${from}.`);
      return 1;
    }
    const picked = await pickBoundary(open(from));
    if (!picked.feature) {
      error(`Граница края не получена: ${picked.reason}.`);
      return 1;
    }
    writeFileSync(to, JSON.stringify(picked.feature));
    log(`Граница края: контур ${REGION_ISO}, один.`);
    return 0;
  }
  const [input, areaLabel] = argv;
  if (!input) {
    error('Нужно: node scripts/help-points-osm-census.mjs <in.geojsonseq> [подпись области]');
    return 2;
  }
  if (!existsSync(input)) {
    error(`Файла выгрузки нет: ${input}. Перепись не выполнялась.`);
    return 1;
  }
  const result = await readCensus(open(input));
  for (const line of formatReport(result, areaLabel || 'не названа')) log(line);
  if (result.broken > 0) {
    error(`В выгрузке ${result.broken} нечитаемых строк — счёт неполон, верить ему нельзя.`);
    return 1;
  }
  if (result.lines === 0 || result.matched === 0) {
    error('Ноль точек на весь край — поломка выгрузки или фильтра, а не пустой край.');
    return 1;
  }
  const lost = missingControl(result);
  if (lost.length > 0) {
    error(`Вырезка неполна: нет контрольных населённых пунктов (${lost.join(', ')}). Перепись не засчитана.`);
    return 1;
  }
  const far = KINDS.reduce((n, k) => n + result.byKind[k.key].bands.far, 0);
  log(`Итог: точек помощи ${result.matched}, из них дальше 200 км от Петропавловска ${far}.`);
  return 0;
}

// Запущен ли файл как программа. Пути сравниваются развёрнутыми: запуск по
// ссылке на каталог иначе молча ничего бы не сделал и вышел с кодом 0.
const invokedAs = process.argv[1];
if (invokedAs && existsSync(invokedAs) && realpathSync(invokedAs) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
