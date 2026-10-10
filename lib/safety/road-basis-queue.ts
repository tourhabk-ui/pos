/**
 * Очередь поиска основания (10.10): какие посты-ограничения ещё не проверены
 * и запись исхода. Без зрения и без модели — этот модуль импортирует приём
 * ленты (safety-ingest), которому модель не положена; само чтение снимка —
 * lib/safety/road-basis.ts, его зовёт только /api/cron/road-basis.
 *
 * Правила записи: основание — только поверх пустого (ручное, вписанное
 * человеком, автомат не трогает никогда); срок пункта — только вверх
 * (GREATEST): лучше лишний час показывать «закрыто», чем отправить людей на
 * закрытую косу из-за неверно прочитанной цифры. Отказ зрения — unavailable
 * и повтор через час (§4.0: «не смогли проверить» не равно «документа нет»).
 */
import { query } from '@/lib/database';

export type BasisReading =
  | { outcome: 'found'; title: string; validUntil: Date | null }
  | { outcome: 'no_document'; reason: string }
  | { outcome: 'unavailable'; reason: string };

/** Повтор после отказа зрения — не чаще раза в час. */
export const BASIS_RETRY_SQL = `INTERVAL '1 hour'`;

interface Queryable {
  query: typeof query;
}
const db0: Queryable = { query };

/**
 * Из кандидатов (пост-ограничение со снимком) — те, у кого основания ещё нет
 * и снимок не смотрели (или смотрели, но зрение не ответило, и прошёл час).
 * Ручное основание не трогается никогда; истёкший пункт — тоже.
 */
export async function pendingBasisChecks(externalIds: string[], db: Queryable = db0): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const { rows } = await db.query<{ external_id: string }>(
    `SELECT external_id FROM external_alerts
      WHERE external_id = ANY($1::text[])
        AND expires_at > NOW()
        AND basis_title IS NULL
        AND (basis_check_outcome IS NULL
             OR (basis_check_outcome = 'unavailable' AND basis_checked_at < NOW() - ${BASIS_RETRY_SQL}))`,
    [externalIds],
  );
  return new Set(rows.map((r) => r.external_id));
}

/**
 * Записать исход проверки. Основание — только поверх пустого и не ручного;
 * срок пункта — только вверх.
 */
export async function applyBasisReading(
  externalId: string,
  reading: BasisReading,
  basisUrl: string,
  db: Queryable = db0,
): Promise<boolean> {
  if (reading.outcome === 'found') {
    const { rowCount } = await db.query(
      `UPDATE external_alerts
          SET basis_title = $2,
              basis_url = $3,
              basis_origin = 'image_ocr',
              basis_valid_until = $4::timestamptz,
              basis_checked_at = NOW(),
              basis_check_outcome = 'found',
              expires_at = CASE WHEN $4::timestamptz IS NULL THEN expires_at
                                ELSE GREATEST(expires_at, $4::timestamptz) END,
              updated_at = NOW()
        WHERE external_id = $1
          AND basis_title IS NULL`,
      [externalId, reading.title, basisUrl, reading.validUntil ? reading.validUntil.toISOString() : null],
    );
    return (rowCount ?? 0) > 0;
  }
  const { rowCount } = await db.query(
    `UPDATE external_alerts
        SET basis_checked_at = NOW(), basis_check_outcome = $2
      WHERE external_id = $1
        AND basis_title IS NULL`,
    [externalId, reading.outcome],
  );
  return (rowCount ?? 0) > 0;
}
