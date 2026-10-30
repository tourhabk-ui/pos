/**
 * Серверная запись события воронки (#2882, слово владельца 30.10 «бери
 * логирование»).
 *
 * Маяк (lib/funnel/beacon.ts → POST /api/funnel) пишет касания из браузера.
 * Отправка заявки и отказ — факты сервера: их знает только тот, кто заводит
 * бронь, и писать их должен он, а не браузер (иначе «заявка отправлена» мог бы
 * сообщить кто угодно). Шаги — SERVER_FUNNEL_STEPS, причины отказа —
 * BOOKING_REJECT_REASONS, оба из единого словаря lib/funnel/steps.ts.
 *
 * Правила те же, что у маяка: без ПД (тот же суточный visitorHash, если есть
 * заголовки запроса; у чата и агента его нет — NULL), краулер не пишется,
 * свой заход помечается is_self, отказ записи не глушится — имя шага и
 * SQLSTATE в лог (§4.0), а вызывающему отдаётся исход словом. Запись никогда
 * не бросает: бронь не должна зависеть от аналитики.
 */
import { pool } from '@/lib/db-pool';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';
import { isSelfVisit } from '@/lib/analytics/self-visit';
import { isBotUserAgent } from '@/lib/analytics/bot-detect';
import type { ServerFunnelStep, BookingRejectReason } from '@/lib/funnel/steps';

/** Заголовки запроса, из которых считается анонимный суточный хэш. */
export interface VisitorContext {
  ip: string;
  userAgent: string;
  cookie: string | null;
}

export type ServerFunnelEvent =
  | { step: 'booking_submitted'; entityId: string | null; source: string; visitor?: VisitorContext | null }
  | { step: 'booking_rejected'; entityId: string | null; source: string; reason: BookingRejectReason; visitor?: VisitorContext | null };

export type RecordOutcome = 'ok' | 'skipped_bot' | 'not_written';

export const RECORD_FUNNEL_SQL = `INSERT INTO funnel_events (step, entity_id, visitor_hash, is_self, reason, source)
   VALUES ($1::varchar, $2::text, $3::varchar, $4::boolean, $5::varchar, $6::varchar)`;

export async function recordFunnelEvent(
  ev: ServerFunnelEvent,
  db: Pick<typeof pool, 'query'> = pool,
): Promise<RecordOutcome> {
  const visitor = ev.visitor ?? null;
  if (visitor && isBotUserAgent(visitor.userAgent)) return 'skipped_bot';
  const hash = visitor
    ? visitorHash(visitor.ip, visitor.userAgent, currentDay(), process.env.CRON_SECRET ?? 'vedar')
    : null;
  const isSelf = visitor ? isSelfVisit(visitor.cookie) : false;
  const reason = ev.step === 'booking_rejected' ? ev.reason : null;
  const step: ServerFunnelStep = ev.step;
  try {
    await db.query(RECORD_FUNNEL_SQL, [step, ev.entityId, hash, isSelf, reason, ev.source]);
    return 'ok';
  } catch (err) {
    const e = err as { message?: string; code?: string } | null;
    console.error(
      `[funnel] серверное событие «${step}» не записано:`,
      e?.message ?? 'неизвестная ошибка',
      `SQLSTATE=${e?.code ?? 'нет'}`,
    );
    return 'not_written';
  }
}

/** Контекст посетителя из заголовков запроса — одной строкой у каждой двери. */
export function visitorFromHeaders(headers: Headers, ip: string): VisitorContext {
  return { ip, userAgent: headers.get('user-agent') ?? '', cookie: headers.get('cookie') };
}
