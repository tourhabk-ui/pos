/**
 * Журнал акцепта оферты партнёром: запись и чтение (план готовности 23.11,
 * этап 5, миграция 1508).
 *
 * Журнал только пополняется: каждый акцепт — новая строка с версией оферты.
 * Версию ставит этот файл из `OFFER_VERSION`, а не вызывающий: записать акцепт
 * «без версии» или с чужой версией через эти функции нельзя.
 */
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { OFFER_ROLES, OFFER_VERSION } from '@/lib/legal/offer';

type Db = Pick<PoolClient, 'query'>;

export type OfferAcceptSource = 'registration' | 'cabinet';

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

function cleanIp(ip: string | null | undefined): string | null {
  const v = (ip ?? '').trim().slice(0, 64);
  return v ? v : null;
}

/**
 * Акцепт при регистрации: по строке на каждую карточку человека, которая —
 * сторона оферты (роль с заявками). Зовётся В ТРАНЗАКЦИИ регистрации, после
 * создания карточек: нет карточки — нет и акцепта, и наоборот.
 *
 * Возвращает число записанных строк. Ноль при партнёрской регистрации —
 * ошибка вызывающего (карточка не создалась): он обязан откатить.
 */
export async function recordOfferAcceptanceForUser(
  client: Db,
  opts: { userId: string; ip: string | null | undefined; source: OfferAcceptSource },
): Promise<number> {
  const { rowCount } = await client.query(
    `INSERT INTO partner_offer_acceptances (partner_id, user_id, offer_version, ip, source)
     SELECT p.id, $1::uuid, $2::varchar, $3::varchar, $4::varchar
       FROM partners p
      WHERE p.user_id = $1::uuid AND p.category = ANY($5::text[])`,
    [opts.userId, OFFER_VERSION, cleanIp(opts.ip), opts.source, [...OFFER_ROLES]],
  );
  return rowCount ?? 0;
}

/** Акцепт одной карточкой — кнопка в кабинете у партнёра, заведённого раньше. */
export async function recordOfferAcceptanceForPartner(
  opts: { partnerId: string; userId: string; ip: string | null | undefined },
  db: Db = pool,
): Promise<'recorded' | 'db_error'> {
  try {
    await db.query(
      `INSERT INTO partner_offer_acceptances (partner_id, user_id, offer_version, ip, source)
       VALUES ($1::uuid, $2::uuid, $3::varchar, $4::varchar, 'cabinet')`,
      [opts.partnerId, opts.userId, OFFER_VERSION, cleanIp(opts.ip)],
    );
    return 'recorded';
  } catch (err) {
    console.error('[offer] акцепт оферты не записан, SQLSTATE', sqlstate(err));
    return 'db_error';
  }
}

export interface OfferAcceptance {
  /** Редакция, которую приняли. */
  version: string;
  /** Совпадает ли она с действующей. */
  current: boolean;
  acceptedAt: string;
}

/**
 * Последний акцепт карточки. `null` — акцепта в журнале нет (партнёр заведён
 * до галочки или администратором); `'unknown'` — прочитать не удалось: это не
 * «не принимал» (§4.0).
 */
export async function readOfferAcceptance(partnerId: string, db: Db = pool): Promise<OfferAcceptance | null | 'unknown'> {
  try {
    const { rows } = await db.query<{ offer_version: string; accepted_at: Date | string }>(
      `SELECT offer_version, accepted_at
         FROM partner_offer_acceptances
        WHERE partner_id = $1::uuid
        ORDER BY accepted_at DESC, id DESC
        LIMIT 1`,
      [partnerId],
    );
    const row = rows[0];
    if (!row) return null;
    const at = row.accepted_at instanceof Date ? row.accepted_at.toISOString() : String(row.accepted_at);
    return { version: row.offer_version, current: row.offer_version === OFFER_VERSION, acceptedAt: at };
  } catch (err) {
    console.error('[offer] акцепт оферты не прочитан, SQLSTATE', sqlstate(err));
    return 'unknown';
  }
}
