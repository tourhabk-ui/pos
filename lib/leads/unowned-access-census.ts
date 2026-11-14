/**
 * Перепись «кто имел доступ к заявкам без адресата» — только числа.
 *
 * До 14.11 заявку без адресата (имя, телефон, почта, комментарий) читал любой
 * вошедший с ролью оператора. Читал ли кто-то на деле, узнать нечем: чтение не
 * записывалось. Перепись отвечает на то, что узнать можно, — сколько аккаунтов
 * проходило проверку роли и скольким из них список закрыт теперь, и сколько
 * таких заявок лежало в базе.
 *
 * Кабинет аккаунта находится так же, как его находит дверь
 * (`operatorAccess`, lib/operators/team-access): своя карточка оператора, иначе
 * карточка команды. Допуск — `partners.is_public` этой карточки
 * (`operatorLeadScope`, lib/leads/ownership).
 *
 * Имён, почт, телефонов и id в ответе нет: ответ уходит в лог прогона на
 * раннере, а репозиторий публичный.
 */
import { pool } from '@/lib/db-pool';

/** Аккаунты с ролью оператора по тому, какой кабинет им находит дверь. */
export const ACCESS_ACCOUNTS_SQL = `
  WITH op_users AS (
    SELECT u.id, u.created_at
      FROM users u
     WHERE u.role = 'operator'
        OR (JSONB_TYPEOF(u.preferences->'roles') = 'array' AND u.preferences->'roles' ? 'operator')
  ),
  cabinet AS (
    SELECT u.id, u.created_at,
           own.id IS NOT NULL AS has_own, own.is_public AS own_public,
           mem.partner_id IS NOT NULL AS has_team, mem.is_public AS team_public
      FROM op_users u
      LEFT JOIN LATERAL (
        SELECT p.id, p.is_public
          FROM partners p
         WHERE p.user_id = u.id AND p.category = 'operator'
         ORDER BY p.created_at ASC NULLS LAST, p.id ASC
         LIMIT 1
      ) own ON TRUE
      LEFT JOIN LATERAL (
        SELECT m.partner_id, p.is_public
          FROM operator_members m
          JOIN partners p ON p.id = m.partner_id AND p.category = 'operator'
         WHERE m.user_id = u.id AND m.status = 'active'
         LIMIT 1
      ) mem ON TRUE
  ),
  judged AS (
    SELECT created_at, has_own, has_team,
           CASE WHEN has_own THEN own_public IS TRUE
                WHEN has_team THEN team_public IS TRUE
                ELSE FALSE END AS admitted
      FROM cabinet
  )
  SELECT COUNT(*)::int                                                        AS accounts_total,
         COUNT(*) FILTER (WHERE admitted)::int                                AS admitted,
         COUNT(*) FILTER (WHERE has_own AND NOT admitted)::int                AS own_card_not_shown,
         COUNT(*) FILTER (WHERE NOT has_own AND has_team AND NOT admitted)::int AS team_card_not_shown,
         COUNT(*) FILTER (WHERE NOT has_own AND NOT has_team)::int            AS no_card,
         COUNT(*) FILTER (WHERE NOT admitted AND created_at > NOW() - INTERVAL '90 days')::int AS closed_registered_90d
    FROM judged`;

/** Заявки без адресата: сколько их лежало под этой дверью. */
export const UNOWNED_LEADS_SQL = `
  SELECT COUNT(*)::int                                                                           AS leads_total,
         COUNT(*) FILTER (WHERE operator_id IS NULL)::int                                        AS unowned_total,
         COUNT(*) FILTER (WHERE operator_id IS NULL AND is_self = FALSE)::int                    AS unowned_not_own_probe,
         COUNT(*) FILTER (WHERE operator_id IS NULL AND created_at > NOW() - INTERVAL '30 days')::int AS unowned_30d,
         COUNT(*) FILTER (WHERE operator_id IS NULL AND created_at > NOW() - INTERVAL '90 days')::int AS unowned_90d
    FROM leads`;

/**
 * Заявки, которые сейчас числятся за карточкой оператора не на витрине. Среди
 * них и адресованные ей (виджет, тур), и занятые из общего списка — различить
 * их по данным нельзя, поэтому это верхняя граница занятых, а не их число.
 */
export const HELD_BY_NOT_SHOWN_SQL = `
  SELECT COUNT(*)::int AS leads, COUNT(DISTINCT l.operator_id)::int AS cards
    FROM leads l
    JOIN partners p ON p.id = l.operator_id
   WHERE p.category = 'operator' AND p.is_public IS NOT TRUE AND l.is_self = FALSE`;

/**
 * Что получает карточка партнёра, если вставка не назвала `is_public`. Два пути
 * создания карточки при входе (lib/auth/partner-profile, lib/auth/operator-helpers)
 * колонку не называют и живут на умолчании: будь оно TRUE, допуск выдавался бы
 * сам. Миграция 694 объявляла DEFAULT TRUE, снимок схемы прода — DEFAULT false;
 * что стоит в базе на деле, говорит сама база.
 */
export const CARD_DEFAULT_SQL = `
  SELECT column_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'partners' AND column_name = 'is_public'`;

export interface CardDefaultRow { column_default: string | null }

/**
 * Попадает ли новая карточка на витрину без слова администратора:
 * true / false, либо null — умолчание записано так, что прочитать его не вышло.
 */
export function shownByDefault(row: CardDefaultRow): boolean | null {
  const d = row.column_default;
  if (d === null) return false; // умолчания нет — в колонке NULL, это «не на витрине»
  if (/^\s*'?(false|f)'?(::boolean)?\s*$/i.test(d)) return false;
  if (/^\s*'?(true|t)'?(::boolean)?\s*$/i.test(d)) return true;
  return null;
}

export interface AccountsRow {
  accounts_total: number; admitted: number; own_card_not_shown: number;
  team_card_not_shown: number; no_card: number; closed_registered_90d: number;
}
export interface UnownedRow {
  leads_total: number; unowned_total: number; unowned_not_own_probe: number; unowned_30d: number; unowned_90d: number;
}
export interface HeldRow { leads: number; cards: number }

export interface UnownedAccessCensus {
  accounts: AccountsRow & { closed_now: number };
  unowned_leads: UnownedRow;
  held_by_not_shown_cards: HeldRow;
  /** Умолчание колонки `partners.is_public` и что оно значит для новой карточки. */
  new_card_default: { column_default: string | null; shown_by_default: boolean | null };
  verdict: string;
  not_known: string[];
}

/** Числа → ответ переписи со словами. Чистая: судится вызовом. */
export function buildUnownedAccessCensus(a: AccountsRow, u: UnownedRow, h: HeldRow, d: CardDefaultRow): UnownedAccessCensus {
  const closedNow = a.own_card_not_shown + a.team_card_not_shown + a.no_card;
  const shown = shownByDefault(d);
  const defaultWords = shown === false
    ? ' Новая карточка без слова администратора на витрину не попадает.'
    : shown === true
      ? ' ВНИМАНИЕ: новая карточка по умолчанию попадает на витрину — допуск к заявкам без адресата выдаётся сам.'
      : ` ВНИМАНИЕ: умолчание колонки «на витрине» не прочитано (${d.column_default}) — попадает ли новая карточка на витрину, неизвестно.`;
  const verdict = `Аккаунтов с ролью оператора ${a.accounts_total}. Заявки без адресата по-прежнему видят ${a.admitted} `
    + `(кабинет на витрине). Закрыто с 14.11: ${closedNow} — своя карточка не на витрине ${a.own_card_not_shown}, `
    + `карточка команды не на витрине ${a.team_card_not_shown}, без карточки ${a.no_card}; из них зарегистрированы `
    + `за 90 дней ${a.closed_registered_90d}. Заявок без адресата в базе ${u.unowned_total} `
    + `(за 30 дней ${u.unowned_30d}, за 90 дней ${u.unowned_90d}).${defaultWords}`;
  return {
    accounts: { ...a, closed_now: closedNow },
    unowned_leads: u,
    held_by_not_shown_cards: h,
    new_card_default: { column_default: d.column_default, shown_by_default: shown },
    verdict,
    not_known: [
      'читал ли кто-то из закрытых аккаунтов заявки без адресата — чтение не записывалось',
      'сколько заявок карточки не на витрине заняли из общего списка — занятая и адресованная заявка в данных не различаются',
      'сколько заявок без адресата было раньше и уже занято или удалено',
    ],
  };
}

export async function runUnownedAccessCensus(db: Pick<typeof pool, 'query'> = pool): Promise<UnownedAccessCensus> {
  const [accounts, unowned, held, cardDefault] = await Promise.all([
    db.query<AccountsRow>(ACCESS_ACCOUNTS_SQL),
    db.query<UnownedRow>(UNOWNED_LEADS_SQL),
    db.query<HeldRow>(HELD_BY_NOT_SHOWN_SQL),
    db.query<CardDefaultRow>(CARD_DEFAULT_SQL),
  ]);
  // Ноль строк у счёта — отказ; ноль строк у умолчания — колонки нет, а на ней стоит допуск.
  if (!accounts.rows[0] || !unowned.rows[0] || !held.rows[0] || !cardDefault.rows[0]) {
    throw new Error('перепись доступа: запрос вернул ноль строк');
  }
  return buildUnownedAccessCensus(accounts.rows[0], unowned.rows[0], held.rows[0], cardDefault.rows[0]);
}
