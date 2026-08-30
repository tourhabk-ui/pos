/**
 * Safety Decision Ledger — append-only история жизненного цикла одного
 * safety-алерта конвейера external_alerts (сейсмика, МЧС, FIRMS).
 *
 * Фаза 1 (по итогам аудита block/buzz): source_observed → signal_normalized
 * → geo_matched|geo_unmatched → risk_classified → published|dedup_skipped
 * → route_or_tour_impact_calculated → traveller_notified. Human-approval
 * события (human_approved/human_rejected) и снятие (superseded/expired)
 * сюда НЕ входят — нет реального писателя для них (см. миграцию 925 и
 * комментарий ниже у SafetyLedgerEventType).
 *
 * Fail-soft по прецеденту governed-action.ts/finishEvoRunTask: ledger —
 * наблюдатель конвейера ингеста, не его условие. Отказ записи не должен
 * ронять сам ingest (safety-критичный путь) — ловится здесь же, причина
 * в console.error, вызывающий получает {ok:false, reason} и продолжает.
 */

import { createHash } from 'node:crypto';
import { pool } from '@/lib/db-pool';

export type SafetyLedgerEventType =
  | 'source_observed'
  | 'fetch_failed'
  | 'signal_normalized'
  | 'dedup_skipped'
  | 'geo_matched'
  | 'geo_unmatched'
  | 'risk_classified'
  | 'published'
  | 'route_or_tour_impact_calculated'
  | 'traveller_notified';

export type SafetyLedgerActorType = 'source' | 'agent' | 'editor' | 'system';

export interface AppendSafetyEventInput {
  entityId: string | null;
  eventType: SafetyLedgerEventType;
  actorType: SafetyLedgerActorType;
  actorId?: string;
  sourceUrl?: string;
  sourcePublishedAt?: Date | null;
  payloadHash?: string;
  priorEventId?: number;
  decisionReason?: string;
  details?: Record<string, unknown>;
}

export interface AppendSafetyEventResult {
  ok: boolean;
  id?: number;
  reason?: string;
}

/** sha256 канонической части сырого item источника — коррелирует события ДО вставки строки в entity-таблицу. */
export function hashPayload(raw: Record<string, unknown>): string {
  const canonical = JSON.stringify(raw, Object.keys(raw).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export async function appendSafetyEvent(input: AppendSafetyEventInput): Promise<AppendSafetyEventResult> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO safety_decision_events
         (entity_id, event_type, actor_type, actor_id, source_url,
          source_published_at, payload_hash, prior_event_id, decision_reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id::text`,
      [
        input.entityId,
        input.eventType,
        input.actorType,
        input.actorId ?? null,
        input.sourceUrl ?? null,
        input.sourcePublishedAt ?? null,
        input.payloadHash ?? null,
        input.priorEventId ?? null,
        input.decisionReason ?? null,
        JSON.stringify(input.details ?? {}),
      ],
    );
    return { ok: true, id: Number(rows[0]!.id) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[safety-ledger] запись не удалась:', input.eventType, reason);
    return { ok: false, reason };
  }
}
