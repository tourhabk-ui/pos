/**
 * lib/routes/duplicate-audit.ts
 *
 * Сколько маршрутов в справочнике описывают одно и то же.
 *
 * ── Откуда взялся вопрос ───────────────────────────────────────────────────
 *
 * Пересуд привязок 11.08 дал 106 «неоднозначных» — треков, рядом с которыми
 * стоит другой маршрут вплотную. Разбор показал, что это в основном не чужие
 * привязки, а НАШИ СОБСТВЕННЫЕ ДВОЙНИКИ:
 *
 *   «Вулкан Горелый»                 ⟷ «Вулкан Горелый»
 *   «Маршрут Пиначево - Центральный» ⟷ «Маршрут Пиначево — Центральный»
 *   «Озеро Толмачева»                ⟷ «На каяках по озеру Толмачево»
 *
 * Вторая пара отличается только видом тире. Совпадение по имени их не
 * склеило, они живут двумя записями, и трек лёг на ту из них, чей якорь в
 * семидесяти четырёх километрах от него.
 *
 * Значит часть «лажи с маршрутами» не про геометрию вовсе: объектов в
 * справочнике больше, чем мест на Камчатке.
 *
 * ── Чего этот модуль НЕ делает ─────────────────────────────────────────────
 *
 * Не объявляет дубликатом по одной близости якорей. Урок Эссо: на Камчатке
 * маршруты стартуют из общих посёлков, и «две записи в одной точке» —
 * законная картина для перевалки. Близость идёт уликой только вместе с
 * похожим именем; всё остальное считается отдельно и называется своим
 * именем — «стоят рядом», а не «дубликаты».
 *
 * READ-ONLY: ничего не пишет и ничего не сливает.
 */

import { pool } from '@/lib/db-pool';
import { normalizeTitle } from '@/lib/import/kml-inbox';

/** Насколько близко якоря, чтобы вопрос вообще возник, км. */
export const SAME_SPOT_KM = 0.3;

/** Слова короче этого в сравнении имён не участвуют: «на», «по», «и». */
const MIN_TOKEN = 4;

/**
 * Сколько начальных букв слова сравнивать.
 *
 * Русское словоизменение меняет хвост: Толмачева / Толмачево / Толмачевом.
 * Шести букв хватает, чтобы «толмач» совпало, и мало, чтобы совпало что-то
 * постороннее.
 */
const STEM = 6;

const R = 6371;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const t = (d: number) => (d * Math.PI) / 180;
  const dLat = t(lat2 - lat1), dLng = t(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Родовые слова, общие для половины справочника.
 *
 * «Вулкан Горелый» и «Вулкан Мутновский» делят слово «вулкан», но общего у
 * них ровно столько же, сколько у двух улиц слово «улица». Основа роднит,
 * только если она в имени СОБСТВЕННОМ.
 *
 * Список намеренно короткий и из наших же названий: длинный список общих слов
 * начинает выкусывать смысл («источники» в «Малкинские источники» — родовое,
 * а вот «Дачные горячие источники» без него теряет половину имени, поэтому
 * решает не одно слово, а наличие ХОТЯ БЫ ОДНОЙ негородовой общей основы).
 */
const GENERIC = new Set([
  'вулкан', 'сопка', 'гора', 'хребет', 'перевал', 'кальде',
  'озеро', 'озера', 'озеру', 'река', 'реки', 'ручей', 'бухта', 'залив',
  'источ', 'термал', 'водопа', 'долина', 'кордон', 'парк', 'мыс',
  'маршру', 'поход', 'тропа', 'тур', 'экскур', 'камчат',
]);

/** Значимые основы слов названия. Родовые слова отбрасываются. */
export function stems(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeTitle(title).split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < MIN_TOKEN) continue;
    const stem = w.slice(0, STEM);
    if (GENERIC.has(stem)) continue;
    out.add(stem);
  }
  return out;
}

/** Есть ли у названий общая значимая основа. */
export function shareStem(a: string, b: string): boolean {
  const sa = stems(a);
  for (const s of stems(b)) if (sa.has(s)) return true;
  return false;
}

/**
 * Концы пути, если название их называет: «Пиначево — Центральный».
 *
 * Возвращает null, когда название устроено иначе («Вулкан Горелый»).
 * Приведение уже свело все виды тире к дефису и убрало пробелы вокруг него,
 * поэтому делить можно по одному символу.
 */
export function endpoints(title: string): [string, string] | null {
  const parts = normalizeTitle(title).split('-').map((s) => s.trim()).filter(Boolean);
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

/**
 * Про одно ли эти два названия.
 *
 * Общий конец пути — не общий маршрут, и это не тонкость, а картина
 * справочника. Скопления якорей 11.08: на кордоне «Центральный» стоят
 * «Авачинский — Центральный», «Радыгино — Центральный», «5 стройка —
 * Центральный», «Центральный — Таловские источники». Слово «Центральный»
 * у них общее ПО УСТРОЙСТВУ НАЗВАНИЯ: так называется точка, из которой они
 * расходятся. Считать их одним предметом — та же ошибка, что считать одним
 * маршрутом всё, что выходит из Эссо, только на уровне букв, а не координат.
 *
 * Поэтому у названий-пар предметом считается ПАРА концов целиком: совпасть
 * должны оба, в любом порядке (обратный обход — тот же путь). Названия иного
 * устройства судятся как прежде — по общей значимой основе.
 */
export function sameSubject(a: string, b: string): boolean {
  const ea = endpoints(a), eb = endpoints(b);
  if (!ea || !eb) return shareStem(a, b);
  return (shareStem(ea[0], eb[0]) && shareStem(ea[1], eb[1]))
    || (shareStem(ea[0], eb[1]) && shareStem(ea[1], eb[0]));
}

export type DuplicateKind =
  /** Названия совпадают после приведения — двойник наверняка. */
  | 'same_name'
  /** Якоря в одной точке И названия про одно — очень вероятно двойник. */
  | 'same_spot_same_subject'
  /**
   * Якоря в одной точке, названия про разное.
   *
   * НЕ дубликат: на Камчатке это обычная перевалка, откуда расходятся разные
   * маршруты (урок Эссо). Считается отдельно, чтобы не выдать общий порог за
   * общий объект.
   */
  | 'same_spot_only';

export interface DuplicatePair {
  kind: DuplicateKind;
  a: { id: string; title: string };
  b: { id: string; title: string };
  anchorKm: number;
}

/** Сколько маршрутов делит одну и ту же точку якоря. */
export interface AnchorCluster {
  lat: number;
  lng: number;
  routes: number;
  /** Несколько названий — по ним видно, ЧТО это за точка. */
  sample: string[];
}

export interface DuplicateAudit {
  routes_counted: number;
  /**
   * Насколько якорь вообще различает маршруты.
   *
   * Пары «стоят в одной точке» ничего не говорят сами по себе — надо знать,
   * СКОЛЬКО различных точек обслуживают четыреста двадцать один маршрут.
   * Если их шестьдесят, то якорь — это не адрес маршрута, а адрес кордона,
   * и всякая привязка по близости опиралась на величину, общую у десятков
   * записей.
   */
  distinct_anchors: number;
  /** Крупнейшие скопления: по названиям видно, что это за общая точка. */
  anchor_clusters: AnchorCluster[];
  by_kind: Record<DuplicateKind, number>;
  /** Сколько маршрутов участвует хотя бы в одной паре-двойнике. */
  routes_in_duplicates: number;
  thresholds: { same_spot_km: number; stem_len: number };
  worst: DuplicatePair[];
  duration_ms: number;
}

interface Row { id: string; title: string | null; lat: string | null; lng: string | null }

export async function runDuplicateAudit(): Promise<DuplicateAudit> {
  const startedAt = Date.now();

  // Сколько РАЗЛИЧНЫХ точек обслуживают справочник. Округление до пятого
  // знака (~1 м) — чтобы «та же точка» не рассыпалась на шум последних цифр.
  const clusterRes = await pool.query<{ lat: string; lng: string; n: string; sample: string[] }>(
    `SELECT round(lat::numeric, 5)::text AS lat,
            round(lng::numeric, 5)::text AS lng,
            COUNT(*)::text AS n,
            (array_agg(title ORDER BY title))[1:4] AS sample
       FROM kamchatka_routes
      WHERE (is_visible = TRUE OR is_visible IS NULL)
        AND lat IS NOT NULL AND lng IS NOT NULL AND title IS NOT NULL
      GROUP BY 1, 2
      ORDER BY COUNT(*) DESC`,
  );
  const distinct_anchors = clusterRes.rows.length;
  const anchor_clusters: AnchorCluster[] = clusterRes.rows
    .filter((r) => parseInt(r.n, 10) > 1)
    .slice(0, 12)
    .map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lng),
      routes: parseInt(r.n, 10),
      sample: r.sample ?? [],
    }));

  const res = await pool.query<Row>(
    `SELECT id::text, title, lat::text, lng::text
       FROM kamchatka_routes
      WHERE (is_visible = TRUE OR is_visible IS NULL)
        AND title IS NOT NULL`,
  );

  const routes = res.rows
    .map((r) => ({
      id: r.id,
      title: r.title as string,
      norm: normalizeTitle(r.title as string),
      lat: Number(r.lat),
      lng: Number(r.lng),
    }))
    .filter((r) => r.norm !== '');

  const by_kind: Record<DuplicateKind, number> = {
    same_name: 0, same_spot_same_subject: 0, same_spot_only: 0,
  };
  const pairs: DuplicatePair[] = [];
  const involved = new Set<string>();

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i], b = routes[j];
      const sameName = a.norm === b.norm;

      // Расстояние считается, только если обе координаты годные. Отсутствие
      // координат — не ноль километров: пара без координат судится именем.
      const haveCoords = Number.isFinite(a.lat) && Number.isFinite(a.lng)
        && Number.isFinite(b.lat) && Number.isFinite(b.lng);
      const km = haveCoords ? haversineKm(a.lat, a.lng, b.lat, b.lng) : Infinity;
      const sameSpot = km <= SAME_SPOT_KM;

      let kind: DuplicateKind | null = null;
      if (sameName) kind = 'same_name';
      else if (sameSpot) kind = sameSubject(a.title, b.title) ? 'same_spot_same_subject' : 'same_spot_only';
      if (!kind) continue;

      by_kind[kind] += 1;
      if (kind !== 'same_spot_only') {
        involved.add(a.id);
        involved.add(b.id);
      }
      pairs.push({
        kind,
        a: { id: a.id, title: a.title },
        b: { id: b.id, title: b.title },
        anchorKm: haveCoords ? Math.round(km * 100) / 100 : -1,
      });
    }
  }

  // Сначала уверенные двойники, потом «одно место, один предмет».
  const order: Record<DuplicateKind, number> = {
    same_name: 0, same_spot_same_subject: 1, same_spot_only: 2,
  };
  pairs.sort((x, y) => order[x.kind] - order[y.kind] || x.anchorKm - y.anchorKm);

  return {
    routes_counted: routes.length,
    distinct_anchors,
    anchor_clusters,
    by_kind,
    routes_in_duplicates: involved.size,
    thresholds: { same_spot_km: SAME_SPOT_KM, stem_len: STEM },
    worst: pairs.slice(0, 25),
    duration_ms: Date.now() - startedAt,
  };
}
