/**
 * lib/crm/events.ts — лента клиента партнёра (CRM фаза 1, шаг 1б, #2325).
 *
 * Событие — то, что произошло с клиентом у партнёра: сменился статус брони
 * или заявки, партнёр записал звонок или заметку, прошло сообщение чата.
 * Пишут его три поверхности одними функциями: роут экрана, Кузьмич партнёра
 * и MCP партнёра (1д) — здесь только запись и чтение, без знания о том, кто
 * позвал.
 *
 * Правила:
 *  - событие источника находит клиента по связи `crm_contact_links`; связи
 *    нет (хук когда-то отказал, бронь старше CRM) — сначала привязка, и
 *    только потом запись: событие без клиента — запись в никуда;
 *  - заголовок и payload строит код из статусов и названий, ПД туда не
 *    попадают; текст заметки — слова партнёра о своём клиенте, живёт в нашей
 *    базе и в модель уходит только через redactPII (1д);
 *  - писатель события никогда не роняет того, кто его позвал: отказ — вид и
 *    SQLSTATE в лог (`recordSourceEventQuietly`), бронь важнее ленты.
 */
import { pool } from '@/lib/db-pool';
import { isValidSourceId, linkContactFromSource, type SourceKind } from '@/lib/crm/contacts';
import { SOURCE_KIND_LABELS, statusLabel } from '@/lib/crm/labels';
import type { CrmEventRow } from '@/lib/types/db-rows';
import {
  DETAILS_MAX, TITLE_MAX, type ActorKind, type EventKind, type TouchKind,
} from '@/lib/crm/event-kinds';

export { EVENT_KINDS, TOUCH_KINDS, ACTOR_KINDS, EVENT_KIND_LABELS } from '@/lib/crm/event-kinds';
export type { ActorKind, EventKind, TouchKind } from '@/lib/crm/event-kinds';

interface Queryable {
  query: typeof pool.query;
}

/** Писатель принимает и пул, и клиента открытой транзакции. */
export interface EventDb extends Queryable {
  connect?: () => Promise<import('pg').PoolClient>;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

function clampTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** Заголовок смены статуса: «Бронь тура: ждёт ответа → подтверждена». */
export function statusChangeTitle(kind: SourceKind, from: string | null | undefined, to: string): string {
  const was = statusLabel(from, kind);
  return clampTitle(`${SOURCE_KIND_LABELS[kind]}: ${was ? `${was} → ` : ''}${statusLabel(to, kind) ?? to}`);
}

export interface SourceEventInput {
  kind: EventKind;
  sourceKind: SourceKind;
  sourceId: string | number | bigint;
  actorKind: ActorKind;
  actorUserId?: string | null;
  title: string;
  /** Без ПД: статусы, даты, числа. */
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export type RecordResult =
  | { outcome: 'recorded'; id: string; partnerId: string; contactId: string }
  | { outcome: 'no_contact' }
  | { outcome: 'bad_id' }
  | { outcome: 'failed'; reason: string };

/**
 * Событие источника: найти клиента по связи, при её отсутствии — привязать,
 * записать событие и поднять `last_activity_at` клиента.
 */
export async function recordSourceEvent(input: SourceEventInput, db: EventDb = pool): Promise<RecordResult> {
  const sourceId = String(input.sourceId);
  if (!isValidSourceId(input.sourceKind, sourceId)) return { outcome: 'bad_id' };

  let link: { partner_id: string; contact_id: string } | undefined;
  try {
    link = (await db.query<{ partner_id: string; contact_id: string }>(
      `SELECT partner_id, contact_id FROM crm_contact_links WHERE source_kind = $1 AND source_id = $2`,
      [input.sourceKind, sourceId],
    )).rows[0];
  } catch (err) {
    console.error('[crm] связь источника не прочитана:', input.sourceKind, 'SQLSTATE', sqlstate(err));
    return { outcome: 'failed', reason: `link ${sqlstate(err)}` };
  }

  if (!link) {
    // Привязка берёт свои соединения из пула: внутри чужой транзакции её не
    // сделать, поэтому без `connect` событие без клиента честно не пишется.
    if (!db.connect) return { outcome: 'no_contact' };
    const linked = await linkContactFromSource(input.sourceKind, sourceId, db as Parameters<typeof linkContactFromSource>[2]);
    if (linked.outcome !== 'linked') {
      return linked.outcome === 'failed' ? { outcome: 'failed', reason: linked.reason } : { outcome: 'no_contact' };
    }
    link = { partner_id: linked.partnerId, contact_id: linked.contactId };
  }

  return insertEvent(db, {
    partnerId: link.partner_id,
    contactId: link.contact_id,
    sourceKind: input.sourceKind,
    sourceId,
    kind: input.kind,
    actorKind: input.actorKind,
    actorUserId: input.actorUserId ?? null,
    title: input.title,
    payload: input.payload ?? {},
    occurredAt: input.occurredAt ?? null,
  });
}

/** Хук в смене статуса: никогда не бросает, отказ — в лог без ПД. */
export async function recordSourceEventQuietly(input: SourceEventInput, db: EventDb = pool): Promise<void> {
  try {
    const r = await recordSourceEvent(input, db);
    if (r.outcome === 'bad_id') console.error('[crm] событие: id источника не того вида:', input.sourceKind);
  } catch (err) {
    console.error('[crm] событие не записано:', input.sourceKind, input.kind, 'SQLSTATE', sqlstate(err));
  }
}

export interface UserEventInput {
  partnerId: string;
  /** Аккаунт туриста — так клиента знает чат, где брони может и не быть. */
  userId: string;
  kind: EventKind;
  actorKind: ActorKind;
  actorUserId?: string | null;
  title: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Событие по аккаунту: клиент партнёра ищется по (партнёр, user_id). Нет
 * клиента — нет события: чат с туристом, который ничего не бронировал,
 * клиентом его не делает (источники клиента — шесть, чат не из них).
 */
export async function recordUserEvent(input: UserEventInput, db: Queryable = pool): Promise<RecordResult> {
  let contactId: string | undefined;
  try {
    contactId = (await db.query<{ id: string }>(
      `SELECT id FROM crm_contacts
        WHERE partner_id = $1 AND user_id = $2
        ORDER BY (phone_e164 IS NULL), created_at, id LIMIT 1`,
      [input.partnerId, input.userId],
    )).rows[0]?.id;
  } catch (err) {
    console.error('[crm] клиент по аккаунту не прочитан, SQLSTATE', sqlstate(err));
    return { outcome: 'failed', reason: `contact ${sqlstate(err)}` };
  }
  if (!contactId) return { outcome: 'no_contact' };
  return insertEvent(db, {
    partnerId: input.partnerId,
    contactId,
    sourceKind: null,
    sourceId: null,
    kind: input.kind,
    actorKind: input.actorKind,
    actorUserId: input.actorUserId ?? null,
    title: input.title,
    payload: input.payload ?? {},
    occurredAt: input.occurredAt ?? null,
  });
}

export interface TouchInput {
  kind: TouchKind;
  title: string;
  details?: string | null;
  actorKind?: Extract<ActorKind, 'partner_user' | 'kuzmich' | 'mcp'>;
  actorUserId?: string | null;
  occurredAt?: Date | null;
}

export type TouchResult =
  | { outcome: 'recorded'; id: string }
  | { outcome: 'not_found' };

/**
 * Касание руками партнёра: заметка, звонок, встреча. Клиент обязан быть его
 * — иначе `not_found`, как у карточки: чужой клиент не существует.
 */
export async function addContactTouch(
  partnerId: string,
  contactId: string,
  input: TouchInput,
  db: Queryable = pool,
): Promise<TouchResult> {
  const own = await db.query<{ id: string }>(
    `SELECT id FROM crm_contacts WHERE id = $1::uuid AND partner_id = $2`,
    [contactId, partnerId],
  );
  if (!own.rows[0]) return { outcome: 'not_found' };
  const details = input.details?.trim() || null;
  const r = await insertEvent(db, {
    partnerId,
    contactId,
    sourceKind: null,
    sourceId: null,
    kind: input.kind,
    actorKind: input.actorKind ?? 'partner_user',
    actorUserId: input.actorUserId ?? null,
    title: input.title,
    payload: details ? { details: details.slice(0, DETAILS_MAX) } : {},
    occurredAt: input.occurredAt ?? null,
  });
  if (r.outcome !== 'recorded') throw new Error(`касание не записано: ${r.outcome}`);
  return { outcome: 'recorded', id: r.id };
}

async function insertEvent(
  db: Queryable,
  e: {
    partnerId: string; contactId: string; sourceKind: SourceKind | null; sourceId: string | null;
    kind: EventKind; actorKind: ActorKind; actorUserId: string | null; title: string;
    payload: Record<string, unknown>; occurredAt: Date | null;
  },
): Promise<RecordResult> {
  const title = clampTitle(e.title);
  if (!title) return { outcome: 'failed', reason: 'empty title' };
  try {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO crm_events
         (partner_id, contact_id, source_kind, source_id, kind, actor_kind, actor_user_id, title, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10::timestamptz, NOW()))
       RETURNING id::text`,
      [e.partnerId, e.contactId, e.sourceKind, e.sourceId, e.kind, e.actorKind, e.actorUserId, title,
       JSON.stringify(e.payload), e.occurredAt],
    );
    await db.query(
      `UPDATE crm_contacts
          SET last_activity_at = GREATEST(last_activity_at, COALESCE($2::timestamptz, NOW())), updated_at = NOW()
        WHERE id = $1`,
      [e.contactId, e.occurredAt],
    );
    return { outcome: 'recorded', id: ins.rows[0].id, partnerId: e.partnerId, contactId: e.contactId };
  } catch (err) {
    console.error('[crm] событие не записано:', e.kind, 'SQLSTATE', sqlstate(err));
    return { outcome: 'failed', reason: `insert ${sqlstate(err)}` };
  }
}

export interface ContactEvent {
  id: string;
  kind: EventKind;
  actor_kind: ActorKind;
  title: string;
  details: string | null;
  source_kind: SourceKind | null;
  source_id: string | null;
  occurred_at: string;
}

/** Лента клиента, свежее сверху. Скоуп партнёра — в SQL. */
export async function listContactEvents(
  partnerId: string,
  contactId: string,
  limit = 50,
  db: Queryable = pool,
): Promise<ContactEvent[]> {
  const { rows } = await db.query<Pick<CrmEventRow, 'id' | 'kind' | 'actor_kind' | 'title' | 'payload' | 'source_kind' | 'source_id' | 'occurred_at'>>(
    `SELECT id::text AS id, kind, actor_kind, title, payload, source_kind, source_id, occurred_at
       FROM crm_events
      WHERE contact_id = $1::uuid AND partner_id = $2
      ORDER BY occurred_at DESC, id DESC
      LIMIT $3`,
    [contactId, partnerId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as EventKind,
    actor_kind: r.actor_kind as ActorKind,
    title: r.title,
    details: typeof r.payload?.details === 'string' ? r.payload.details : null,
    source_kind: (r.source_kind as SourceKind | null) ?? null,
    source_id: r.source_id,
    occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : new Date(r.occurred_at).toISOString(),
  }));
}
