/**
 * Статус главного места тура — в ответе о туре и в заявке на него (ревью MCP
 * 08.11).
 *
 * До этого дня статус места считался только ответом `get_guardian_context`.
 * Описание тура (`get_tour_details`) места не называло вовсе, а заявка на тур
 * к закрытому или красному месту уходила оператору молча: агент, не
 * спросивший обстановку отдельным вызовом, узнать её не мог.
 *
 * Правило статуса — то же, что у карточки места и чата
 * (`placeStatusFields`, lib/safety/place-day-status). Место — только
 * записанная связь `operator_tours.main_place_id` (1286, 1344), и только живое
 * место: скрытое или слитое ничего тура не называет, как в каталоге.
 *
 * Статус — на СЕГОДНЯ. Тур бывает через неделю, и красный сегодня не значит
 * «выезда не будет»: заявку это не останавливает, а состоится ли выезд, решает
 * оператор. Так и сказано в строке, и это же видно в поле `level`.
 */
import { pool } from '@/lib/db-pool';
import { isoUtcSql } from '@/lib/db/timestamp-iso';
import { isOutsideKraiSources } from '@/lib/safety/kuril-north';
import {
  PLACE_COLOR_WORD, kamchatkaStamp, placeStatusFields, type PlaceStatusFields,
} from '@/lib/safety/place-day-status';

/** Колонки, которые `tourPlaceStatusJoinSql` добавляет к строке тура. */
export interface TourPlaceRow {
  tp_place_id: string | null;
  tp_place_name: string | null;
  tp_place_zone: string | null;
  tp_is_open: boolean | null;
  tp_status: string | null;
  tp_status_at: string | null;
}

/**
 * LEFT JOIN LATERAL к строке тура: главное место и его статус. Строка не
 * больше одной: places.id — ключ, location_real_time_status.agent_route_id
 * уникален (070). `tourRef` —
 * таблица или алиас тура в запросе (`operator_tours`, `ot`). Колонки с
 * приставкой `tp_`, чтобы не спорить с колонками тура без алиаса
 * (publicTourSql('')).
 */
export function tourPlaceStatusJoinSql(tourRef: string): string {
  return `LEFT JOIN LATERAL (
         SELECT mp.id::text AS tp_place_id, mp.name AS tp_place_name, mp.zone AS tp_place_zone,
                lrs.is_open AS tp_is_open, lrs.recommender_status AS tp_status,
                ${isoUtcSql('lrs.updated_at')} AS tp_status_at
           FROM places mp
           LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = mp.ark_id
          WHERE mp.id = ${tourRef}.main_place_id AND mp.is_visible = TRUE AND mp.merged_into_id IS NULL
       ) tp ON TRUE`;
}

export interface TourPlaceStatus extends PlaceStatusFields {
  place_id: string;
  place: string;
}

/** null — у тура нет записанного живого главного места. */
export function tourPlaceStatus(row: Partial<TourPlaceRow>, now: number = Date.now()): TourPlaceStatus | null {
  if (typeof row.tp_place_id !== 'string' || !row.tp_place_name) return null;
  return {
    place_id: row.tp_place_id,
    place: row.tp_place_name,
    ...placeStatusFields({
      isOpen: row.tp_is_open ?? null,
      status: row.tp_status ?? null,
      updatedAt: row.tp_status_at ?? null,
      outsideKraiSources: isOutsideKraiSources(row.tp_place_zone ?? null),
    }, now),
  };
}

/** Чем статус кончается всегда: что он значит и где подробности. */
const SCOPE = 'Статус — на сегодня, а не на дату тура, и не гарантия безопасности; '
  + 'предупреждения и опасности места — get_guardian_context с его названием.';

function statePhrase(s: TourPlaceStatus): string {
  if (s.closed) {
    return `сегодня отмечено ЗАКРЫТЫМ${s.color ? ` (статус для выхода ${PLACE_COLOR_WORD[s.color]})` : ''}.`;
  }
  if (s.color) {
    const when = s.status_updated_at ? ` (пересчёт ${kamchatkaStamp(s.status_updated_at)} по Камчатке)` : '';
    return `статус для выхода сегодня ${PLACE_COLOR_WORD[s.color]}${when}.`;
  }
  if (s.stale && s.status_updated_at) {
    return `статус не пересчитывался с ${kamchatkaStamp(s.status_updated_at)} по Камчатке — цвета нет, и это не значит, что там безопасно.`;
  }
  if (s.outside_sources) {
    return 'место вне сводок края — цвета нет, сказать «предупреждений нет» нельзя.';
  }
  return 'статус не рассчитан — это не значит, что там безопасно.';
}

/** Строка ответа о туре: есть место — его статус, нет — так и сказано. */
export function tourPlaceStatusLine(s: TourPlaceStatus | null): string {
  if (!s) {
    return 'Главное место у тура не записано — статуса места в этом ответе нет; '
      + 'обстановку по месту из программы даёт get_guardian_context.';
  }
  return `Главное место тура — «${s.place}»: ${statePhrase(s)} ${SCOPE}`;
}

/** Строка для заявки: только когда сказать человеку есть что — закрыто, красный, жёлтый. */
export function tourPlaceRequestNote(s: TourPlaceStatus | null): string {
  if (!s || !(s.closed || s.color === 'red' || s.color === 'yellow')) return '';
  return ` Главное место тура «${s.place}» ${statePhrase(s)} Скажите об этом человеку: заявку это не останавливает, `
    + `состоится ли выезд на выбранную дату, подтвердит оператор. ${SCOPE}`;
}

/** Строка для заявки, когда статус места прочитать не удалось (§4.0: «не смог» ≠ «нет»). */
export const TOUR_PLACE_NOT_READ_NOTE = ' Статус главного места тура прочитать не удалось — '
  + 'не говорите человеку, что предупреждений нет; обстановку даёт get_guardian_context.';

/**
 * Главное место тура и его статус одним запросом. null — у тура нет живого
 * главного места. Отказ базы — исключение: вызывающий называет его словами
 * (TOUR_PLACE_NOT_READ_NOTE), а не молчит.
 */
export async function loadTourPlaceStatus(tourId: number, now: number = Date.now()): Promise<TourPlaceStatus | null> {
  const { rows } = await pool.query<TourPlaceRow>(
    `SELECT tp.* FROM operator_tours ot ${tourPlaceStatusJoinSql('ot')} WHERE ot.id = $1`,
    [tourId],
  );
  return rows[0] ? tourPlaceStatus(rows[0], now) : null;
}
