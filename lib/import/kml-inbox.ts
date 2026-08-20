/**
 * KML-инбокс: приём треков от сообщества (телеграм-каналы карт Камчатки,
 * выгрузки idilesom и т.п.). Файлы кладутся в data/tracks-inbox/ репозитория,
 * workflow постит их на прод-эндпоинт /api/cron/kml-inbox.
 *
 * Правила честности:
 *  - реальные треки (source osm/idilesom/visitkamchatka или немаркированный
 *    настоящий) НЕ перетираются — community-трек пишется только поверх
 *    пустой геометрии, синтетики или прежнего kml_inbox;
 *  - маршрут без совпадения создаётся СКРЫТЫМ (is_visible=false) — очередь
 *    на ревью админа, как у прочих импортов;
 *  - автор трека сохраняется в metadata (атрибуция), в LLM не уходит.
 */

import { pool } from '@/lib/db-pool';

export interface ParsedKml {
  name: string;
  uploader: string | null;
  coordinates: number[][];
}

export interface KmlImportOutcome {
  filename: string;
  track_name: string;
  status: 'imported' | 'created_hidden' | 'kept_existing_track' | 'no_coords' | 'parse_error';
  matched_route?: string;
  matched_route_id?: string;
  /** Чем совпало. Только имя: близость снята с роли ключа (см. ниже). */
  match_by?: 'name';
  points?: number;
  existing_source?: string;
}

/** Разбор KML: имя документа + координаты первого LineString ([lng,lat]). */
export function parseKml(xml: string): ParsedKml | null {
  const nameMatch = xml.match(/<name>([\s\S]*?)<\/name>/);
  const coordsMatch = xml.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
  if (!coordsMatch) return null;

  const coordinates: number[][] = [];
  for (const token of coordsMatch[1].trim().split(/\s+/)) {
    const parts = token.split(',').map(Number);
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    const [lng, lat, alt] = parts;
    // высоту сохраняем только когда она есть и не нулевая заглушка
    coordinates.push(alt && Number.isFinite(alt) && alt !== 0 ? [lng, lat, alt] : [lng, lat]);
  }

  const { name, uploader } = cleanTrackName(nameMatch?.[1] ?? '');
  return { name, uploader, coordinates };
}

/**
 * «Маршрут Озеро Синичкино. Маршрут загрузил(а) Roman Pozdny» →
 * name «Озеро Синичкино», uploader «Roman Pozdny».
 */
export function cleanTrackName(raw: string): { name: string; uploader: string | null } {
  let s = raw.trim().replace(/\s+/g, ' ');
  let uploader: string | null = null;

  const up = s.match(/маршрут загрузил\(?а\)?[:\s]+(.+?)\.?$/i);
  if (up) {
    uploader = up[1].trim();
    s = s.slice(0, up.index).trim();
  }
  s = s.replace(/^маршрут\s+/i, '').replace(/[.\s]+$/, '').trim();
  return { name: s || raw.trim() || 'Безымянный трек', uploader };
}

/**
 * Приведение названия к сравнимому виду.
 *
 * Тире складывается ко всем видам сразу, и это не косметика. Пересуд привязок
 * 11.08 нашёл в справочнике два маршрута:
 *
 *   «Маршрут Пиначево - Центральный»   (дефис)
 *   «Маршрут Пиначево — Центральный»   (тире)
 *
 * Для человека это одно название. Для сравнения строк — разные, поэтому
 * совпадение по имени их не склеило, они живут двумя записями, и трек лёг на
 * ту из них, чей якорь в семидесяти четырёх километрах от него.
 *
 * Сюда же кавычки и лишняя пунктуация по краям: источники их ставят
 * по-разному, а различие смысла не несёт.
 *
 * И слово «Маршрут» в начале. Оно ничего не называет — это подпись жанра, как
 * «улица» в адресе. В справочнике оно у одних записей есть, у других нет
 * («Маршрут Пиначево — Центральный» и «Пиначево - Центральный»), а разбор
 * имени трека из KML его снимает всегда (cleanTrackName). Пока правило жило
 * в одном месте из двух, сравнение имён расходилось само с собой: трек
 * «Маршрут Пиначево - Центральный» приходил как «Пиначево-Центральный» и не
 * узнавал одноимённую запись. Это ровно тот же класс, что SQL-чистка против
 * TS-стража, — одно правило в двух местах, копии разъехались.
 */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ёЁ]/g, 'е')
    .replace(/^\s*маршрут\s+/, '')
    // Все виды тире и дефисов — к одному: дефис, минус, en/em-dash, non-breaking.
    .replace(/[\u2010-\u2015\u2212\u00AD-]/g, '-')
    .replace(/[«»"'`]/g, '')
    // Пробелы вокруг тире не значимы: «а - б», «а-б», «а — б» — одно и то же.
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?-]+|[\s.,;:!?-]+$/g, '')
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

/** Габарит трека, км: диагональ его ограничивающего прямоугольника. */
export function trackSpanKm(coords: number[][]): number {
  if (coords.length < 2) return 0;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return haversineKm(minLat, minLng, maxLat, maxLng);
}

/**
 * Расстояние от точки до ближайшей вершины трека, км.
 *
 * Именно до ВСЕГО трека: маршрут может лежать посередине пути, и мерить
 * только до концов значит не увидеть очевидное совпадение — и увидеть
 * ложное, когда мимо чужого конца прошли по дороге.
 */
export function distanceToTrackKm(lat: number, lng: number, coords: number[][]): number {
  let best = Infinity;
  for (const [cLng, cLat] of coords) {
    const d = haversineKm(lat, lng, cLat, cLng);
    if (d < best) best = d;
  }
  return best;
}

/**
 * ── Ниже — пороги, которыми судится ПРОШЛОЕ, а не делается новое ───────────
 *
 * Привязка по близости из импорта убрана: из 290 сделанных ею привязок
 * проверку выдержала 31, а 106 имели рядом другой маршрут-конкурент.
 *
 * Пороги остались, потому что ими пересуживаются УЖЕ СДЕЛАННЫЕ привязки
 * (lib/routes/track-attachment-audit): судить вчерашние решения надо той
 * меркой, которая называет их слабость, а не выбрасывать мерку вместе с
 * правилом. Для новых привязок они не применяются.
 */

/** Якорь маршрута в пределах этого радиуса от ТРЕКА — при пересуде прошлого. */
export const MAX_MATCH_DIST_KM = 4;

/**
 * Насколько второй кандидат должен быть дальше первого, чтобы выбор считался
 * однозначным.
 *
 * Без этого «ближайший из двух почти одинаковых» выдаётся за найденный
 * маршрут. Полевой разбор 11.08: трек «Вулкан Ичинская сопка» привязался к
 * «Эссовским (Уксичанским) термальным источникам» — разные объекты, и спасло
 * только то, что у источников трек уже был.
 */
export const AMBIGUOUS_MARGIN_KM = 2;

/**
 * Длиннее этого трек по близости НЕ привязывается — только по имени.
 *
 * Причина камчатская и простая: длинный маршрут начинается у посёлка, а
 * посёлок общий. Эссо — перевалка и к Уксичанским источникам, и к Ичинской
 * сопке; старт трека в километре от Эссо не говорит о том, КУДА этот трек
 * ведёт. Для короткого трека тот же километр — почти всё расстояние, и там
 * близость действительно свидетельствует.
 *
 * Ошибка здесь дороже пропуска: непривязанный трек уходит на ревью и ждёт
 * человека, а привязанный к чужому маршруту ведёт человека не туда.
 */
export const PROXIMITY_MAX_TRACK_KM = 10;

/** Источники геометрии, поверх которых community-трек писать МОЖНО. */
const OVERWRITABLE_SOURCES = new Set(['waypoints_synthetic', 'kml_inbox']);

export async function importKmlTrack(filename: string, xml: string): Promise<KmlImportOutcome> {
  const parsed = parseKml(xml);
  if (!parsed) return { filename, track_name: filename, status: 'parse_error' };
  if (parsed.coordinates.length < 2) {
    return { filename, track_name: parsed.name, status: 'no_coords', points: parsed.coordinates.length };
  }

  const [startLng, startLat] = parsed.coordinates[0];

  // Записи БЕЗ координат тоже участвуют, и это следствие отказа от близости.
  // Прежний `WHERE lat IS NOT NULL` стоял здесь ради неё — сравнивать было не
  // с чем. Сравнению ПО ИМЕНИ координаты не нужны, а таких записей в
  // справочнике сто с лишним (перепись 11.08: 287 точек на 421 маршрут).
  // Оставь фильтр — и трек с совпадающим именем прошёл бы мимо своей записи и
  // завёл ей двойника, то есть ровно ту болезнь, которую мы лечим.
  const { rows } = await pool.query<{
    id: string; title: string; geom_source: string | null; has_geometry: boolean;
    is_visible: boolean;
  }>(
    `SELECT id, title,
            geometry->>'source' AS geom_source,
            (geometry IS NOT NULL) AS has_geometry,
            is_visible
     FROM kamchatka_routes
     WHERE title IS NOT NULL AND merged_into_id IS NULL`,
  );

  const wanted = normalizeTitle(parsed.name);

  // 1) точное совпадение нормализованного названия — оно и есть надёжное.
  //
  // Тёзок может быть несколько: импорты плодили семьи дублей, и часть из
  // них скрыта уборками. Перепись 20.08 показала цену выбора «первый
  // попавшийся»: трек ложился в СКРЫТЫЙ дубль, живая запись оставалась
  // без линии, и на карте не менялось ничего. Поэтому порядок предпочтения
  // явный: живая без трека → живая (перезаписываемая) → скрытая. Слитые
  // записи (merged_into_id) не участвуют вовсе.
  const candidates = rows.filter(r => normalizeTitle(r.title) === wanted);
  candidates.sort((a, b) =>
    Number(b.is_visible) - Number(a.is_visible)
    || Number(a.has_geometry) - Number(b.has_geometry));
  const match = candidates[0] ?? null;
  const matchBy: 'name' | null = match ? 'name' : null;

  // 2) близости здесь БОЛЬШЕ НЕТ, и это решение по цифрам.
  //
  // Основание — пересуд ВСЕХ сделанных привязок (track-attachment-audit,
  // 11.08, 290 треков):
  //
  //   holds       31    привязка выдерживает проверку
  //   track_long  152   трек длиннее порога — близость о нём не говорит
  //   ambiguous   106   рядом стоял ДРУГОЙ маршрут, выбор не однозначен
  //   anchor_far    1
  //
  // Тридцать одна привязка из двухсот девяноста. Больше трети имели
  // конкурента в пределах запаса — то есть выбирался не тот самый маршрут, а
  // ближайший из нескольких. Полевой случай: трек «Вулкан Ичинская сопка»
  // привязался к «Эссовским (Уксичанским) термальным источникам», потому что
  // Эссо — перевалка и туда, и туда.
  //
  // Три условия (длина, расстояние до всей линии, однозначность) эти случаи
  // ловят, но ценой отказа почти во всём: остаётся тридцать одна привязка из
  // двухсот девяноста, и каждая всё равно держится на том, что рядом никого
  // не оказалось. Правило, срабатывающее в одном случае из десяти и
  // ошибающееся в остальных, лучше убрать, чем настраивать.
  //
  // Чего в этом обосновании НЕТ (и было по ошибке в первой редакции): будто
  // якоря общие и потому бесполезны. Перепись 11.08 показала обратное — 287
  // различных точек на 421 маршрут, самое большое скопление в три записи.
  // «Пять маршрутов на одной координате» оказалось следствием бага в самой
  // переписи: `Number(null)` — ноль, и записи БЕЗ координат вставали в
  // Гвинейский залив. Якорь различает; ненадёжна привязка ПО НЕМУ, когда
  // трек длинный и соседи близко.
  //
  // Что остаётся: совпадение по имени — оно различает и уже нашло двойника,
  // невидимого до приведения тире. Нет совпадения — маршрут создаётся
  // СКРЫТЫМ в очередь на ревью. Непривязанный трек ждёт человека;
  // привязанный к чужому маршруту ведёт человека.

  const geojson = JSON.stringify({ type: 'LineString', coordinates: parsed.coordinates, source: 'kml_inbox' });
  const meta = JSON.stringify({
    kml_inbox: { file: filename, uploader: parsed.uploader, original_name: parsed.name },
  });

  if (match) {
    // Реальный трек не перетираем
    if (match.has_geometry && match.geom_source !== null && !OVERWRITABLE_SOURCES.has(match.geom_source)) {
      return {
        filename, track_name: parsed.name, status: 'kept_existing_track',
        matched_route: match.title, matched_route_id: match.id,
        match_by: matchBy ?? undefined, existing_source: match.geom_source,
      };
    }
    if (match.has_geometry && match.geom_source === null) {
      // немаркированный настоящий трек — тоже не трогаем
      return {
        filename, track_name: parsed.name, status: 'kept_existing_track',
        matched_route: match.title, matched_route_id: match.id,
        match_by: matchBy ?? undefined, existing_source: '(без метки)',
      };
    }
    await pool.query(
      `UPDATE kamchatka_routes
       SET geometry = $1::jsonb,
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [geojson, meta, match.id],
    );
    return {
      filename, track_name: parsed.name, status: 'imported',
      matched_route: match.title, matched_route_id: match.id,
      match_by: matchBy ?? undefined, points: parsed.coordinates.length,
    };
  }

  // Нет совпадения — создаём скрытым в очередь на ревью
  await pool.query(
    `INSERT INTO kamchatka_routes (
       category, title, lat, lng, geometry, metadata,
       source_name, is_visible, dedupe_key
     ) VALUES ('trekking', $1, $2, $3, $4::jsonb, $5::jsonb, 'community-kml', false, $6)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET geometry = EXCLUDED.geometry,
           metadata = COALESCE(kamchatka_routes.metadata, '{}'::jsonb) || EXCLUDED.metadata
       WHERE kamchatka_routes.geometry IS NULL
          OR kamchatka_routes.geometry->>'source' IN ('kml_inbox', 'waypoints_synthetic')`,
    [parsed.name, startLat, startLng, geojson, meta, `kml:${wanted}`],
  );
  return {
    filename, track_name: parsed.name, status: 'created_hidden',
    points: parsed.coordinates.length,
  };
}
