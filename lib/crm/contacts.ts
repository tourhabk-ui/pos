/**
 * lib/crm/contacts.ts — клиент партнёра: склейка из источников (CRM фаза 1,
 * шаг 1а, #2325).
 *
 * Источник — строка, в которой партнёр впервые узнал человека: бронь тура,
 * бронь жилья, заказ проката, место в машине, лид, клиент агента. Каждая знает
 * человека по-своему (у гостя нет аккаунта, у проката нет аккаунта вовсе, у
 * перевозчика бывает только телефон), поэтому чтение источника — свой SQL на
 * вид, а склейка — одна.
 *
 * Склейка внутри ОДНОГО партнёра: телефон в E.164 → почта → аккаунт. Разные
 * партнёры — разные контакты всегда: ПД не перетекают между партнёрами.
 * Один телефон у двух имён — один контакт: для связи телефон и есть личность,
 * а имя, записанное источником, видно в карточке у каждого источника.
 *
 * CRM не расширяет доступ к ПД. В контакт попадают ровно те поля, которые
 * партнёр уже получает по этому источнику — на экранах и в уведомлении о брони:
 *   - оператор — имя, телефон и почту из брони, а где брони сказать нечего — из
 *     аккаунта туриста (так их показывают «Клиенты» оператора,
 *     `lib/operator/screen-queries.ts`);
 *   - владелец жилья — имя, телефон и почту гостя из аккаунта (экран броней и
 *     уведомление о брони `notifyNewStayBooking`);
 *   - перевозчик — телефон заказа и имя заказавшего партнёра, без имени и
 *     почты аккаунта туриста (`listSeatRequests`);
 *   - гиду контакты из броней не копируются вовсе: его доступ к туристу
 *     временный — назначение, команда оператора, предстоящая бронь
 *     (`lib/guides/team-queries.ts`), а контакт постоянный;
 *   - запрос мест — не источник: контакты туриста оператор получает только
 *     после «есть места» (решение 29.09, `lib/seat-requests/service.ts`), и
 *     тогда клиента заводит бронь.
 *
 * Согласие копируется из источника, где оно записано (брони туров, лиды), и
 * только в контакт, у которого его ещё нет.
 */
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { pool } from '@/lib/db-pool';
import type { PoolClient } from 'pg';

import {
  SOURCE_KINDS, isSourceKind, isValidSourceId, SOURCE_SQL, UNLINKED_PAGE_SQL, UNLINKED_WHERE,
  UNLINKED_COUNT_SQL, cursorStart, type SourceKind, type SourcePersonRow,
} from '@/lib/crm/source-specs';

// Источники как SQL-текст живут в lib/crm/source-specs (без пула и записи);
// здесь — привязка. Реэкспорт, чтобы вызывающие не меняли импортов.
export {
  SOURCE_KINDS, isSourceKind, isValidSourceId, SOURCE_SQL, UNLINKED_PAGE_SQL, UNLINKED_WHERE,
  UNLINKED_COUNT_SQL, cursorStart,
};
export type { SourceKind, SourcePersonRow };

// ── Нормализация ─────────────────────────────────────────────────────────────

export function normalizeName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 200) : null;
}

/** Почта как ключ: без пробелов, нижний регистр, есть «@» и точка после него. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Телефон как ключ — то же правило, что у заявок (lib/mcp/normalize-phone). */
export function normalizePhoneKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return normalizePhone(raw);
}

export interface PersonKey {
  name: string | null;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  emailNorm: string | null;
  userId: string | null;
}

export function personKey(row: Pick<SourcePersonRow, 'person_name' | 'phone' | 'email' | 'user_id'>): PersonKey {
  const phone = typeof row.phone === 'string' && row.phone.trim() ? row.phone.trim().slice(0, 40) : null;
  const email = typeof row.email === 'string' && row.email.trim() ? row.email.trim().slice(0, 200) : null;
  return {
    name: normalizeName(row.person_name),
    phone,
    phoneE164: normalizePhoneKey(phone),
    email,
    emailNorm: normalizeEmail(email),
    userId: row.user_id ?? null,
  };
}

/** По чему склеивается человек: первый непустой ключ. none — склеивать не по чему. */
export function keyKind(k: PersonKey): 'phone' | 'email' | 'user' | 'none' {
  if (k.phoneE164) return 'phone';
  if (k.emailNorm) return 'email';
  if (k.userId) return 'user';
  return 'none';
}

// ── Склейка ──────────────────────────────────────────────────────────────────

export interface CrmDb {
  query: typeof pool.query;
  connect: () => Promise<PoolClient>;
}

export type LinkResult =
  | { outcome: 'linked'; partnerId: string; contactId: string; created: boolean }
  | { outcome: 'no_source' }
  | { outcome: 'no_contact' }
  | { outcome: 'bad_id' }
  | { outcome: 'failed'; reason: string };

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * Найти или завести контакт человека у партнёра и привязать к нему источник.
 * Всё в одной транзакции: контакт без связи с источником не остаётся. Гонка
 * двух привязок одного источника решается уникальностью связи: проигравший
 * откатывается и читает победителя.
 */
async function linkOne(
  client: PoolClient,
  kind: SourceKind,
  sourceId: string,
  row: SourcePersonRow,
): Promise<{ contactId: string; created: boolean } | 'no_contact'> {
  const existing = await client.query<{ contact_id: string }>(
    `SELECT contact_id FROM crm_contact_links WHERE source_kind = $1 AND source_id = $2`,
    [kind, sourceId],
  );
  if (existing.rows[0]) return { contactId: existing.rows[0].contact_id, created: false };

  const k = personKey(row);
  const kk = keyKind(k);
  if (kk === 'none' && !k.name) return 'no_contact';

  const occurred = iso(row.occurred_at);
  const consent = row.pd_consent_at
    ? [iso(row.pd_consent_at), row.pd_consent_ip, row.pd_consent_source, row.pd_consent_version]
    : [null, null, null, null];

  await client.query('BEGIN');
  try {
    let contactId: string | null = null;
    let created = false;

    const find = async (sql: string, params: unknown[]): Promise<string | null> =>
      (await client.query<{ id: string }>(sql, params)).rows[0]?.id ?? null;

    if (kk === 'phone') {
      contactId = await find(
        `SELECT id FROM crm_contacts WHERE partner_id = $1 AND phone_e164 = $2 FOR UPDATE`,
        [row.partner_id, k.phoneE164],
      );
      // Человек уже известен по почте или аккаунту без телефона — телефон
      // дописывается ему, а не заводит второго.
      if (!contactId && k.emailNorm) {
        contactId = await find(
          `SELECT id FROM crm_contacts
            WHERE partner_id = $1 AND email_norm = $2 AND phone_e164 IS NULL
            ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
          [row.partner_id, k.emailNorm],
        );
      }
      if (!contactId && k.userId) {
        contactId = await find(
          `SELECT id FROM crm_contacts
            WHERE partner_id = $1 AND user_id = $2 AND phone_e164 IS NULL
            ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
          [row.partner_id, k.userId],
        );
      }
      if (contactId) {
        await client.query(
          `UPDATE crm_contacts SET phone = COALESCE(phone, $2), phone_e164 = $3 WHERE id = $1 AND phone_e164 IS NULL`,
          [contactId, k.phone, k.phoneE164],
        );
      }
    } else if (kk === 'email') {
      contactId = await find(
        `SELECT id FROM crm_contacts
          WHERE partner_id = $1 AND email_norm = $2
          ORDER BY (phone_e164 IS NULL), created_at, id LIMIT 1 FOR UPDATE`,
        [row.partner_id, k.emailNorm],
      );
    } else if (kk === 'user') {
      contactId = await find(
        `SELECT id FROM crm_contacts
          WHERE partner_id = $1 AND user_id = $2
          ORDER BY (phone_e164 IS NULL AND email_norm IS NULL), created_at, id LIMIT 1 FOR UPDATE`,
        [row.partner_id, k.userId],
      );
    }

    if (!contactId) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO crm_contacts
           (partner_id, user_id, display_name, phone, phone_e164, email, email_norm, origin,
            pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version,
            first_seen_at, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
         RETURNING id`,
        [row.partner_id, k.userId, k.name, k.phone, k.phoneE164, k.email, k.emailNorm, kind, ...consent, occurred],
      );
      contactId = ins.rows[0].id;
      created = true;
    } else {
      // Дописать недостающее, не перетирая записанного. Почта дописывается
      // только контакту с телефоном: у контакта без телефона почта — ключ
      // склейки, и его нашли бы по ней раньше.
      await client.query(
        `UPDATE crm_contacts SET
           user_id          = COALESCE(user_id, $2),
           display_name     = COALESCE(display_name, $3),
           email            = CASE WHEN phone_e164 IS NOT NULL THEN COALESCE(email, $4) ELSE email END,
           email_norm       = CASE WHEN phone_e164 IS NOT NULL THEN COALESCE(email_norm, $5) ELSE email_norm END,
           pd_consent_ip      = CASE WHEN pd_consent_at IS NULL AND $6::timestamptz IS NOT NULL THEN $7 ELSE pd_consent_ip END,
           pd_consent_source  = CASE WHEN pd_consent_at IS NULL AND $6::timestamptz IS NOT NULL THEN $8 ELSE pd_consent_source END,
           pd_consent_version = CASE WHEN pd_consent_at IS NULL AND $6::timestamptz IS NOT NULL THEN $9 ELSE pd_consent_version END,
           pd_consent_at      = COALESCE(pd_consent_at, $6::timestamptz),
           first_seen_at    = LEAST(first_seen_at, $10::timestamptz),
           last_activity_at = GREATEST(last_activity_at, $10::timestamptz),
           updated_at       = NOW()
         WHERE id = $1`,
        [contactId, k.userId, k.name, k.email, k.emailNorm, ...consent, occurred],
      );
    }

    const link = await client.query<{ contact_id: string }>(
      `INSERT INTO crm_contact_links (contact_id, partner_id, source_kind, source_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_kind, source_id) DO NOTHING
       RETURNING contact_id`,
      [contactId, row.partner_id, kind, sourceId, occurred],
    );
    if (!link.rows[0]) {
      // Источник успели привязать параллельно — наш контакт не нужен.
      await client.query('ROLLBACK');
      const winner = await client.query<{ contact_id: string }>(
        `SELECT contact_id FROM crm_contact_links WHERE source_kind = $1 AND source_id = $2`,
        [kind, sourceId],
      );
      return { contactId: winner.rows[0].contact_id, created: false };
    }
    await client.query('COMMIT');
    return { contactId, created };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/**
 * Привязать источник к контакту партнёра, который знает по нему человека.
 * Идемпотентно: повтор возвращает тот же контакт.
 */
export async function linkContactFromSource(
  kind: SourceKind,
  sourceId: string,
  db: CrmDb = pool,
): Promise<LinkResult> {
  if (!isValidSourceId(kind, sourceId)) return { outcome: 'bad_id' };
  let row: SourcePersonRow | undefined;
  try {
    row = (await db.query<SourcePersonRow>(SOURCE_SQL[kind], [sourceId])).rows[0];
  } catch (err) {
    console.error('[crm] источник не прочитан:', kind, 'SQLSTATE', sqlstate(err));
    return { outcome: 'failed', reason: `read ${sqlstate(err)}` };
  }
  if (!row) return { outcome: 'no_source' };

  // Уникальность телефона может столкнуться с параллельной вставкой того же
  // человека от другого источника — один повтор её разводит.
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      const r = await linkOne(client, kind, sourceId, row);
      if (r === 'no_contact') return { outcome: 'no_contact' };
      return { outcome: 'linked', partnerId: row.partner_id, ...r };
    } catch (err) {
      if (sqlstate(err) === '23505' && attempt === 0) continue;
      console.error('[crm] контакт не привязан:', kind, 'SQLSTATE', sqlstate(err));
      return { outcome: 'failed', reason: `link ${sqlstate(err)}` };
    } finally {
      client.release();
    }
  }
}

/**
 * Хук на создание источника: привязать и ни в коем случае не уронить того,
 * кто его позвал. Бронь важнее CRM — отказ пишется в лог с видом источника и
 * SQLSTATE, без ПД; пропущенное подберёт задел `GET /api/cron/crm-contacts-sync`.
 */
export async function linkContactQuietly(
  kind: SourceKind,
  sourceId: string | number | bigint | null | undefined,
  db: CrmDb = pool,
): Promise<void> {
  if (sourceId === null || sourceId === undefined) return;
  try {
    const r = await linkContactFromSource(kind, String(sourceId), db);
    if (r.outcome === 'bad_id') console.error('[crm] хук: id источника не того вида:', kind);
  } catch (err) {
    console.error('[crm] хук упал:', kind, 'SQLSTATE', sqlstate(err));
  }
}
