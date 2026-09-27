/**
 * Channel Manager — оркестратор внешних маркетплейсов
 *
 * Запускается кроном каждые 30 минут:
 *   GET /api/cron/channel-sync?secret=...
 *
 * Алгоритм:
 * 1. Для каждого активного канала → pollOrders(since)
 * 2. Новые заказы → upsert в channel_orders
 *
 * Создания operator_booking и уведомления из заказа канала НЕТ: заказы
 * копятся в channel_orders. Прежняя строка шапки обещала этот шаг, а кода
 * под ней не было — докстрока, обещающая путь, которого нет (§10.09).
 *
 * Три исхода на канал, а не два (§4.0): synced, not_configured (ключей нет —
 * это не «ноль заказов»), failed (ключи есть, опрос не удался).
 */

import { pool } from '@/lib/db-pool';
import { tripsterAdapter } from './tripster';
import { avitoAdapter } from './avito';
import type { ChannelBooking, ChannelName } from './types';

const ADAPTERS = [tripsterAdapter, avitoAdapter];

export type ChannelSyncState = 'synced' | 'not_configured' | 'failed';

export interface SyncResult {
  channel: ChannelName;
  state: ChannelSyncState;
  new_orders: number;
  errors: string[];
}

export async function syncAllChannels(since?: Date): Promise<SyncResult[]> {
  const sinceDate = since ?? new Date(Date.now() - 35 * 60 * 1000); // последние 35 мин
  const results: SyncResult[] = [];

  for (const adapter of ADAPTERS) {
    const result: SyncResult = { channel: adapter.name, state: 'synced', new_orders: 0, errors: [] };

    if (!adapter.isConfigured()) {
      result.state = 'not_configured';
      results.push(result);
      continue;
    }

    try {
      const orders = await adapter.pollOrders(sinceDate);

      for (const order of orders) {
        try {
          await upsertChannelOrder(order);
          result.new_orders++;
        } catch (e) {
          result.errors.push(`order ${order.external_id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      result.state = 'failed';
      result.errors.push((e as Error).message);
      console.error(`[channel-sync] ${adapter.name}: опрос не удался:`, (e as Error).message);
    }

    results.push(result);
  }

  return results;
}

async function upsertChannelOrder(order: ChannelBooking): Promise<void> {
  // Найти tour_id по external experience/listing ID
  const tourId = await resolveTourId(order);

  await pool.query(
    `INSERT INTO channel_orders
       (channel, external_id, tour_id, status, tourist_name, tourist_email,
        tourist_phone, participants, booking_date, amount, raw_payload, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (channel, external_id) DO UPDATE SET
       status       = EXCLUDED.status,
       updated_at   = NOW(),
       raw_payload  = EXCLUDED.raw_payload`,
    [
      order.channel, order.external_id, tourId ?? null, order.status,
      order.tourist_name, order.tourist_email, order.tourist_phone,
      order.participants, order.booking_date || null,
      order.amount || null, JSON.stringify(order.raw_payload),
    ]
  );
}

async function resolveTourId(order: ChannelBooking): Promise<number | null> {
  const payload = order.raw_payload;
  let col: string | null = null;
  let val: string | null = null;

  if (order.channel === 'tripster') {
    const exp = payload.experience as Record<string, unknown> | undefined;
    const expId = String(exp?.id ?? '');
    if (expId) { col = 'tripster_experience_id'; val = expId; }
  } else if (order.channel === 'avito') {
    const listingId = String(payload.item_id ?? '');
    if (listingId) { col = 'avito_listing_id'; val = listingId; }
  }

  if (!col || !val) return null;

  const r = await pool.query(
    `SELECT id FROM operator_tours WHERE ${col} = $1 AND deleted_at IS NULL LIMIT 1`,
    [val]
  );
  return r.rows[0]?.id ?? null;
}
