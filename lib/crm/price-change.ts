/**
 * Изменение цен через подтверждение на сайте — K.ai B3.
 *
 * Решение владельца 03.11: ссылка 24 часа, одноразовая, изменение хранится
 * на сервере (в ссылке — только id), подтверждает вошедший с правом цен.
 * Кузьмич зовёт только `createPendingChange`: цены он не пишет никогда.
 *
 * Подтверждение применяет ТО, ЧТО ПОКАЗАНО: базовая цена ставится из
 * предпросмотра и лишь там, где она не менялась с тех пор (иначе «+10%»
 * дважды или поверх чужой правки). Такие туры возвращаются как пропущенные.
 *
 * Запись базовой цены — единая дверь владельца (lib/tours/tour-change, план
 * готовности 23.11, этап 4): у тура на витрине новая цена уходит на проверку
 * администратору и возвращается отдельным списком `pending`. Наценка на
 * выходные (tour_pricing_rules) — второй канал цены, очередь её не касается.
 */
import type { PoolClient } from 'pg';
import type { PriceChange, PricePreview } from '@/lib/crm/price-preview';
import { setWeekendMarkup } from '@/lib/tours/operator-markup';
import { saveTourChange } from '@/lib/tours/tour-change';

export const CHANGE_TTL_MS = 24 * 3600_000;
const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru';

type Db = Pick<PoolClient, 'query'>;

export function confirmUrl(id: string): string {
  return `${SITE}/hub/operator/pricing/confirm?id=${encodeURIComponent(id)}`;
}

export async function createPendingChange(db: Db, operatorId: string, preview: PricePreview, nowMs: number, source = 'chat'): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO operator_price_changes (operator_id, change, preview, source, created_at, expires_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0)) RETURNING id::text AS id`,
    [operatorId, JSON.stringify(preview.change), JSON.stringify(preview), source, nowMs, nowMs + CHANGE_TTL_MS],
  );
  return rows[0].id;
}

export type PendingState = 'open' | 'used' | 'expired';
export interface PendingChange { id: string; change: PriceChange; preview: PricePreview; state: PendingState; expiresAt: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Чужое и несуществующее — одинаково null: не подсказываем, что id есть. */
export async function loadPendingChange(db: Db, operatorId: string, id: string, nowMs: number): Promise<PendingChange | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query(
    `SELECT id::text AS id, change, preview, used_at, expires_at FROM operator_price_changes WHERE id = $1 AND operator_id = $2`,
    [id, operatorId],
  );
  const r = rows[0];
  if (!r) return null;
  const exp = new Date(r.expires_at);
  const state: PendingState = r.used_at ? 'used' : exp.getTime() <= nowMs ? 'expired' : 'open';
  return { id: r.id, change: r.change, preview: r.preview, state, expiresAt: exp.toISOString() };
}

export type ConfirmResult =
  /**
   * `applied` — цена записана сразу; `pending` — ушла на проверку, на витрине
   * пока прежняя; `skipped` — цена менялась после предпросмотра.
   */
  | { outcome: 'applied'; applied: number[]; pending: number[]; skipped: number[] }
  | { outcome: 'not_found' | 'used' | 'expired' };

/** Вызывать в транзакции. Строка гасится тем же запросом, что проверяет срок — второй клик не пройдёт. */
export async function confirmPendingChange(db: Db, operatorId: string, id: string, userId: string | null, nowMs: number): Promise<ConfirmResult> {
  const cur = await loadPendingChange(db, operatorId, id, nowMs);
  if (!cur) return { outcome: 'not_found' };
  if (cur.state !== 'open') return { outcome: cur.state };
  const { rowCount } = await db.query(
    `UPDATE operator_price_changes SET used_at = to_timestamp($3 / 1000.0), confirmed_by = $4
      WHERE id = $1 AND operator_id = $2 AND used_at IS NULL AND expires_at > to_timestamp($3 / 1000.0)`,
    [id, operatorId, nowMs, userId],
  );
  if (!rowCount) return { outcome: 'used' };

  const c = cur.change;
  const ids = cur.preview.tours.map((t) => t.tourId);
  if (c.kind === 'weekend_markup') {
    const applied = await setWeekendMarkup(db, operatorId, ids, c.percent);
    return { outcome: 'applied', applied, pending: [], skipped: ids.filter((i) => !applied.includes(i)) };
  }
  const applied: number[] = [];
  const pending: number[] = [];
  for (const t of cur.preview.tours) {
    // Цена на витрине та же, что в предпросмотре, — под замком строки: иначе
    // «+10%» легло бы поверх чужой правки.
    const same = await db.query(
      `SELECT 1 FROM operator_tours
        WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL AND base_price = $3
        FOR UPDATE`,
      [t.tourId, operatorId, t.baseBefore],
    );
    if (!same.rowCount) continue;
    const w = await saveTourChange(db, {
      tourId: String(t.tourId), ownerId: operatorId, userId,
      input: { base_price: t.baseAfter }, current: {},
    });
    if (w.outcome === 'written') applied.push(t.tourId);
    else if (w.outcome === 'pending') pending.push(t.tourId);
  }
  return { outcome: 'applied', applied, pending, skipped: ids.filter((i) => !applied.includes(i) && !pending.includes(i)) };
}
