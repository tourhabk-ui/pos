/**
 * Очереди партнёрского контура — отчёт администратору (план готовности 23.11,
 * этап 6).
 *
 * Этапы 3–5 завели очереди, которых раньше не было: партнёр ждёт одобрения,
 * одобренного нельзя поставить на витрину без канала, правка тура ждёт
 * проверки, оферта не принята. Каждая видна на своём экране, а сколько их
 * всего — не было видно нигде.
 *
 * В отчёте только числа: ни названий, ни контактов. Имя карточки гида — имя
 * человека, а отчёт удобно переслать; считать можно без имён.
 *
 * Каждое число читается своим запросом. Отказ одного — «не прочитано» у этого
 * числа и строка в логе с SQLSTATE, остальные числа остаются (§4.0): ноль и
 * «не знаю» — разные ответы.
 *
 * Здесь — чтение из базы (серверный модуль). Типы и слова отчёта — в
 * lib/admin/partner-queue-lines.ts: его читает и экран администратора.
 */
import { pool } from '@/lib/db-pool';
import { OFFER_ROLES, OFFER_VERSION } from '@/lib/legal/offer';
import { PARTNER_GROUP_SQL } from '@/lib/partners/partner-groups';
import { NO_CHANNEL_SQL } from '@/lib/partners/reach';
import { publicPartnerSql } from '@/lib/partners/test-profile';
import type { PartnerQueues, QueueCount } from '@/lib/admin/partner-queue-lines';

export type { PartnerQueues, QueueCount } from '@/lib/admin/partner-queue-lines';

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

function logFail(what: string, err: unknown): void {
  const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
  console.error(`[partner-queues] ${what} не прочитано, SQLSTATE`, code);
}

const FROM_PARTNERS = `FROM partners p LEFT JOIN users u_reach ON u_reach.id = p.user_id`;

async function count(db: Db, what: string, where: string, params: unknown[] = []): Promise<QueueCount> {
  try {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n ${FROM_PARTNERS} WHERE ${where}`, params);
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    logFail(what, err);
    return 'unknown';
  }
}

/** Заявка ждёт одобрения. Тестовый профиль — не очередь: его одобряют ради стенда. */
const AWAITING = `p.profile_status = 'pending' AND p.is_test IS NOT TRUE`;

async function awaitingApproval(db: Db): Promise<PartnerQueues['awaitingApproval']> {
  try {
    const { rows } = await db.query(
      `SELECT p.category, COUNT(*)::int AS n FROM partners p WHERE ${AWAITING} GROUP BY p.category ORDER BY p.category`,
    );
    const byCategory = rows.map((r) => ({ category: String(r.category ?? ''), count: Number(r.n) }));
    return { total: byCategory.reduce((sum, r) => sum + r.count, 0), byCategory };
  } catch (err) {
    logFail('заявки на одобрении', err);
    return { total: 'unknown', byCategory: [] };
  }
}

async function tourEdits(db: Db): Promise<PartnerQueues['tourEdits']> {
  try {
    // Род правки — тем же признаком, что очередь модерации: просьба о
    // публикации тура, которого на сайте нет, — новый тур; остальное — правка.
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE e.wants_publish AND ot.is_published IS NOT TRUE)::int AS new_tours,
              COUNT(*) FILTER (WHERE NOT (e.wants_publish AND ot.is_published IS NOT TRUE))::int AS edits
         FROM operator_tour_edits e
         JOIN operator_tours ot ON ot.id = e.tour_id
        WHERE e.moderation_status = 'pending' AND ot.deleted_at IS NULL`,
    );
    return { newTours: Number(rows[0]?.new_tours ?? 0), edits: Number(rows[0]?.edits ?? 0) };
  } catch (err) {
    logFail('очередь проверки туров', err);
    return { newTours: 'unknown', edits: 'unknown' };
  }
}

export async function readPartnerQueues(db: Db = pool as unknown as Db): Promise<PartnerQueues> {
  const [awaiting, storefrontNoChannel, approvedNoChannel, testProfiles, edits, offerNotAccepted] = await Promise.all([
    awaitingApproval(db),
    count(db, 'на витрине без канала', `${publicPartnerSql('p')} AND ${NO_CHANNEL_SQL}`),
    // Агент на витрину не ставится вовсе — канал у него не спрашивается.
    count(db, 'одобрены без канала',
      `p.profile_status = 'approved' AND p.is_public IS NOT TRUE AND p.is_test IS NOT TRUE
       AND p.category <> 'agent' AND ${NO_CHANNEL_SQL}`),
    count(db, 'тестовые профили', `p.is_test IS TRUE`),
    tourEdits(db),
    count(db, 'оферта без отметки',
      `${PARTNER_GROUP_SQL.partners} AND p.is_test IS NOT TRUE AND p.category = ANY($1::text[])
       AND NOT EXISTS (SELECT 1 FROM partner_offer_acceptances a
                        WHERE a.partner_id = p.id AND a.offer_version = $2)`,
      [[...OFFER_ROLES], OFFER_VERSION]),
  ]);
  return { awaitingApproval: awaiting, storefrontNoChannel, approvedNoChannel, testProfiles, tourEdits: edits, offerNotAccepted };
}
