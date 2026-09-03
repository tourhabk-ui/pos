/**
 * Перепись для #1493: у каких маршрутов ЕСТЬ OCR-паспорт и МЕНЬШЕ ДВУХ
 * путевых точек — то есть кому актуатор route-endpoints способен дать
 * обе точки, которых требует черта навигабельности.
 *
 * ── Почему именно эта перепись ───────────────────────────────────────────
 *
 * Замер 01.09 (комментарий к #1493): из трёх законных улик происхождения
 * этапы на странице-доноре дали 0 из 25, совпадение имени даёт одну точку
 * из двух, и только официальный паспорт называет начало И конец. Пробы
 * 202-204 актуатора шли по 18 id, отобранным руками, — без переписи каждая
 * следующая партия такая же слепая.
 *
 * ── Что перепись НЕ делает ───────────────────────────────────────────────
 *
 * Не зовёт модель. Актуатор извлекает точки через LLM, и его сухой прогон
 * стоит токенов на каждый маршрут; перепись — дешёвый отбор, кому этот
 * прогон вообще имеет смысл. Признаки считаются кодом и теми же
 * инструментами, что у актуатора: координата в тексте ищется `parseDms`
 * (тот же парсер, что переводит цитату модели в число), упоминание пункта
 * начала/окончания — теми же словами, что в промпте.
 *
 * Признак — не приговор: паспорт с координатой может описывать её иначе,
 * чем ждёт промпт, а паспорт без — назвать ориентир по имени. Признаки
 * задают ПОРЯДОК партий, а решение о каждой точке по-прежнему принимает
 * сухой прогон актуатора и человек.
 *
 * Отказ запроса — `rows: null` с причиной, не пустой список (§4.0).
 */
import { pool } from '@/lib/db-pool';
import { parseDms } from '@/lib/routes/passport-endpoints';

export const CENSUS_BATCH = 10;

/** Слова, которыми промпт актуатора ищет пункты начала и окончания. */
export const ENDPOINT_MENTION =
  /пункт\s+(начала|окончания)|начал[оа]\s+маршрута|кон(ец|ца)\s+маршрута|координаты\s+(начала|конца)/i;

export interface CensusRow {
  route_id: string;
  title: string;
  waypoints: number;
  markdown_chars: number;
  /** В тексте паспорта есть строка, которую parseDms переводит в координату. */
  coord_hint: boolean;
  /** В тексте есть слова о пункте начала/окончания. */
  mentions_endpoints: boolean;
}

export interface RouteEndpointsCensus {
  routes_with_ocr: number | null;
  already_two_waypoints: number | null;
  candidates: number | null;
  with_coord_hint: number | null;
  with_mentions_only: number | null;
  without_signals: number | null;
  /** Первая партия: маршруты с координатой в тексте, не больше CENSUS_BATCH. */
  next_batch: string[];
  rows: CensusRow[] | null;
  reason: string | null;
}

interface DbRow {
  route_id: string;
  title: string;
  waypoints: string;
  markdown: string;
}

export function rankCandidates(rows: CensusRow[]): CensusRow[] {
  return [...rows].sort((a, b) =>
    Number(b.coord_hint) - Number(a.coord_hint) ||
    Number(b.mentions_endpoints) - Number(a.mentions_endpoints) ||
    a.title.localeCompare(b.title, 'ru'),
  );
}

export async function computeRouteEndpointsCensus(): Promise<RouteEndpointsCensus> {
  let db: DbRow[];
  let withOcr = 0;
  try {
    const r = await pool.query<DbRow & { with_ocr: string }>(
      `SELECT r.id::text AS route_id, r.title, o.markdown,
              (SELECT COUNT(*) FROM route_waypoints rw
                WHERE rw.route_id = r.id AND rw.link_kind = 'waypoint')::text AS waypoints,
              COUNT(*) OVER ()::text AS with_ocr
         FROM kamchatka_routes r
         JOIN route_passport_ocr o ON o.route_id = r.id
        WHERE r.is_visible = true AND r.merged_into_id IS NULL
        ORDER BY r.title`,
    );
    db = r.rows;
    withOcr = r.rows.length > 0 ? parseInt(r.rows[0].with_ocr, 10) : 0;
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : '?';
    console.error('[route-endpoints-census] query failed, SQLSTATE', code, err instanceof Error ? err.message : err);
    return {
      routes_with_ocr: null, already_two_waypoints: null, candidates: null,
      with_coord_hint: null, with_mentions_only: null, without_signals: null,
      next_batch: [], rows: null, reason: 'запрос не выполнился — см. лог сервера',
    };
  }

  const rows: CensusRow[] = [];
  let alreadyTwo = 0;
  for (const d of db) {
    const waypoints = parseInt(d.waypoints, 10) || 0;
    if (waypoints >= 2) { alreadyTwo += 1; continue; }
    const md = d.markdown ?? '';
    rows.push({
      route_id: d.route_id,
      title: d.title,
      waypoints,
      markdown_chars: md.length,
      coord_hint: parseDms(md) !== null,
      mentions_endpoints: ENDPOINT_MENTION.test(md),
    });
  }

  const ranked = rankCandidates(rows);
  const withCoord = ranked.filter(r => r.coord_hint);
  const mentionsOnly = ranked.filter(r => !r.coord_hint && r.mentions_endpoints);
  const none = ranked.filter(r => !r.coord_hint && !r.mentions_endpoints);

  return {
    routes_with_ocr: withOcr,
    already_two_waypoints: alreadyTwo,
    candidates: ranked.length,
    with_coord_hint: withCoord.length,
    with_mentions_only: mentionsOnly.length,
    without_signals: none.length,
    next_batch: withCoord.slice(0, CENSUS_BATCH).map(r => r.route_id),
    rows: ranked,
    reason: null,
  };
}
