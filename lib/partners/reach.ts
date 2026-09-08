/**
 * Достижимость партнёра: ОДИН адрес, а не два.
 *
 * ── Что было (поправка владельца 08.09: «есть у них и тг и макс») ──────────
 *
 * Находка воронки #1719 объявила двух операторов с живыми турами недоступными
 * «ни в MAX, ни в Telegram». Владелец возразил фактом о жизни: каналы у них
 * есть. Обе стороны правы, и вот почему — адрес оператора в Telegram живёт в
 * ДВУХ колонках, и живой код читает то одну, то другую:
 *
 *   partners.telegram_chat_id            users.telegram_id (через partners.user_id)
 *   ──────────────────────────────       ──────────────────────────────────────────
 *   бронь с сайта                        бронь из чата Кузьмича
 *   Watchdog: бронь без ответа >48ч      напоминание о неоплаченной броне
 *   Watchdog: жильё, прокат, трансфер
 *   находка воронки #1719
 *
 * Значение у них одно и то же — `update.message.from.id` из вебхука Telegram.
 * Пишутся они РАЗНЫМИ путями: вход через Telegram (`/api/auth/telegram`) и
 * `/start link_…` в вебхуке ставят обе, но вторая из них — под
 * `.catch(() => null)`. То есть партнёр, у которого запись в `partners` не
 * прошла, остаётся с адресом только в `users` — и для половины платформы
 * становится «неподключённым», будучи подключённым.
 *
 * Цена расхождения ровно та же, что у двух копий создания брони (08.09):
 * бронь из чата до оператора доезжает, бронь с сайта — нет, а Watchdog
 * молчит, потому что смотрит в пустую колонку.
 *
 * ── Правило ───────────────────────────────────────────────────────────────
 *
 * ПРАВИЛО живёт здесь: что считать адресом, какая колонка старше и что значит
 * «достижим». Запросы снаружи читают ОБЕ колонки и зовут `reachFrom()` — одну
 * колонку в одиночку спрашивать нельзя: это ответ на половину вопроса, а
 * выглядит как ответ на весь.
 *
 * Правило не вставляется в чужой SQL строкой. Первая редакция экспортировала
 * готовые куски запроса и подставляла их через `${...}` — и сторож ложных
 * находок (`evo-findings-replay`) немедленно покраснел: интерполяция в текст
 * SQL статически неотличима от конкатенации, а на ней держится вся защита от
 * инъекций в этих файлах. Поэтому SQL везде литеральный, а общее — это тип
 * строки и функция над ней.
 *
 * Сторож: `tests/unit/partner-reach.test.ts`.
 *
 * ── Чего этот модуль НЕ решает ────────────────────────────────────────────
 *
 * Он не сводит две колонки в одну в схеме и ничего не переписывает в базе.
 * Какая из них должна остаться — решение владельца, и оно требует замера: в
 * какой колонке у кого что записано. Перепись даёт `partnerReachCensus()`,
 * и она НЕ показывает сами адреса — только откуда взят каждый.
 */

import { pool } from '@/lib/db-pool';

/**
 * Две колонки адреса, как их отдаёт база. Имена полей закреплены: запрос
 * обязан выбрать их именно так, иначе `reachFrom` молча увидит `undefined`.
 *
 * `SELECT p.telegram_chat_id, u_reach.telegram_id AS user_telegram_id,
 *         p.max_chat_id::text AS max_chat_id
 *    FROM partners p
 *    LEFT JOIN users u_reach ON u_reach.id = p.user_id`
 */
export interface PartnerReachRow {
  /** partners.telegram_chat_id — BIGINT, приходит строкой или числом. */
  telegram_chat_id: string | number | null;
  /** users.telegram_id через partners.user_id. */
  user_telegram_id: string | number | null;
  max_chat_id: string | number | null;
}

export interface PartnerReach {
  telegramChatId: string | null;
  maxChatId: string | null;
  /** `null` — адреса в Telegram нет ни в одной из двух колонок. */
  telegramSource: 'partner' | 'user' | null;
  /** Достижим хотя бы одним каналом. */
  reachable: boolean;
}

/** BIGINT приходит из `pg` то строкой, то числом — приводим в одном месте. */
function asText(v: string | number | null | undefined): string | null {
  return v == null ? null : String(v);
}

/**
 * Адрес по строке с обеими колонками.
 *
 * Старшинство: профиль партнёра, потом аккаунт человека.
 * `partners.telegram_chat_id` заполняется осознанно (админом или командой
 * «партнер» боту), `users.telegram_id` — побочно, входом; при расхождении
 * верить надо первому.
 */
export function reachFrom(row: PartnerReachRow): PartnerReach {
  const fromPartner = asText(row.telegram_chat_id);
  const fromUser    = asText(row.user_telegram_id);
  const telegram    = fromPartner ?? fromUser;
  const max         = asText(row.max_chat_id);
  return {
    telegramChatId: telegram,
    maxChatId:      max,
    telegramSource: fromPartner != null ? 'partner' : fromUser != null ? 'user' : null,
    reachable:      telegram != null || max != null,
  };
}

/**
 * Достижимость партнёра по его id.
 *
 * `null` — партнёра нет ЛИБО запрос не выполнился, и это разные вещи: отказ
 * пишется в лог с SQLSTATE, а вызывающий обязан считать `null` за «не знаю»,
 * а не за «адреса нет» (§4.0).
 */
export async function reachForPartner(partnerId: string): Promise<PartnerReach | null> {
  try {
    const { rows } = await pool.query<PartnerReachRow>(
      `SELECT p.telegram_chat_id,
              u_reach.telegram_id AS user_telegram_id,
              p.max_chat_id
         FROM partners p
         LEFT JOIN users u_reach ON u_reach.id = p.user_id
        WHERE p.id = $1
        LIMIT 1`,
      [partnerId],
    );
    const row = rows[0];
    return row ? reachFrom(row) : null;
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[partner-reach] не смог прочитать адреса партнёра ${partnerId}, SQLSTATE ${code}:`, err);
    return null;
  }
}

/** То же по туру: адрес оператора, которому уходит его бронь. */
export async function reachForTour(tourId: number): Promise<PartnerReach | null> {
  try {
    const { rows } = await pool.query<PartnerReachRow>(
      `SELECT p.telegram_chat_id,
              u_reach.telegram_id AS user_telegram_id,
              p.max_chat_id
         FROM operator_tours ot
         JOIN partners p ON p.id = ot.operator_id
         LEFT JOIN users u_reach ON u_reach.id = p.user_id
        WHERE ot.id = $1
        LIMIT 1`,
      [tourId],
    );
    const row = rows[0];
    return row ? reachFrom(row) : null;
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[partner-reach] не смог прочитать адреса оператора тура ${tourId}, SQLSTATE ${code}:`, err);
    return null;
  }
}

export interface PartnerReachCensusRow {
  name: string;
  live_tours: number;
  /** Есть ли адрес — БЕЗ самого адреса. */
  has_telegram: boolean;
  has_max: boolean;
  telegram_source: 'partner' | 'user' | null;
}

/**
 * Перепись достижимости операторов с живыми турами.
 *
 * Отвечает на вопрос, который расхождение колонок и породило: у кого адрес
 * записан только в аккаунте человека, а в профиле партнёра пуст. Сами адреса
 * наружу не отдаются никогда — это чужой chat_id, и для ответа «дойдёт ли
 * заявка» он не нужен.
 *
 * Считаются только операторы, у которых есть что продавать: партнёр без живых
 * туров недостижим безобидно — ему и присылать нечего.
 */
export async function partnerReachCensus(): Promise<PartnerReachCensusRow[]> {
  const { rows } = await pool.query<PartnerReachRow & { name: string; live_tours: number }>(
    // Оба chat_id — BIGINT (миграции 077 и 145), не текст. Ранняя редакция
    // переписи обернула их в TRIM(), и прод ответил «function
    // pg_catalog.btrim(bigint) does not exist»: перепись упала целиком.
    // Пустой строки у BIGINT не бывает — «есть канал» это просто NOT NULL.
    `SELECT p.name,
            COUNT(t.id)::int AS live_tours,
            p.telegram_chat_id,
            u_reach.telegram_id AS user_telegram_id,
            p.max_chat_id
       FROM partners p
       LEFT JOIN users u_reach ON u_reach.id = p.user_id
       JOIN operator_tours t ON t.operator_id = p.id AND t.is_active = true
      GROUP BY p.id, p.name, p.telegram_chat_id, u_reach.telegram_id, p.max_chat_id`,
  );
  return rows.map((r) => {
    const reach = reachFrom(r);
    return {
      name:            r.name,
      live_tours:      r.live_tours,
      has_telegram:    reach.telegramChatId != null,
      has_max:         reach.maxChatId != null,
      telegram_source: reach.telegramSource,
    };
  });
}
