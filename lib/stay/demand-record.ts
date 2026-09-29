/**
 * Серверная запись спроса на жильё: поиск через инструмент
 * `search_accommodations` (Кузьмич и публичный MCP).
 *
 * Веб-каталог пишет то же событие маяком (`funnelBeacon`) — у него есть
 * посетитель и суточный хэш. У агента посетителя в этом месте нет, поэтому
 * `visitor_hash` пуст: перепись считает агентские поиски штуками, а не
 * людьми, и говорит это вслух.
 *
 * Запись не мешает ответу: ошибка не бросается наружу — турист получает
 * ответ Кузьмича при любой судьбе счётчика. Но и не глушится (§4.0): имя
 * события и SQLSTATE уходят в лог, иначе ноль в переписи был бы неотличим от
 * «счётчик не пишет».
 */

import { pool } from '@/lib/db-pool';
import { staySearchEntity, type StaySearchOutcome } from '@/lib/stay/demand';

export async function recordAgentStaySearch(outcome: StaySearchOutcome): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO funnel_events (step, entity_id, visitor_hash) VALUES ('stay_search', $1, NULL)`,
      [staySearchEntity('agent', outcome)],
    );
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(
      `[stay-demand] поиск жилья агентом (${outcome}) не записан:`,
      e?.message ?? 'неизвестная ошибка',
      `SQLSTATE=${e?.code ?? 'нет'}`,
    );
  }
}
