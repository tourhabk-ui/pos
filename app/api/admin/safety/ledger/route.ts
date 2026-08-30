/**
 * GET /api/admin/safety/ledger — чтение Safety Decision Ledger (925).
 *
 * Read-only, как /api/admin/volcano: ни одной мутации здесь нет и не будет —
 * запись идёт только из конвейера ингеста (lib/safety/ledger.ts,
 * appendSafetyEvent), не через HTTP.
 *
 * ?entity_id=<id> — история одного алерта (все события с этим entity_id ИЛИ
 * с payload_hash, совпадающим с payload_hash события, у которого этот
 * entity_id уже встречался, — иначе ранние source_observed/risk_classified/
 * geo_matched того же item, ещё без entity_id, потерялись бы из выдачи).
 * ?event_type=<type> — фильтр по типу события.
 * ?limit — по умолчанию 100, максимум 500.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface LedgerEventRow {
  id: string;
  entity_type: string;
  entity_id: string | null;
  event_type: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  source_url: string | null;
  payload_hash: string | null;
  prior_event_id: string | null;
  decision_reason: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const params = request.nextUrl.searchParams;
  const entityId = params.get('entity_id');
  const eventType = params.get('event_type');
  const limitParam = Number(params.get('limit') ?? '100');
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 100;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (entityId) {
    // Событие с этим entity_id, ЛИБО событие, чей payload_hash встречается
    // хоть раз у события с этим entity_id — так в выдачу попадают более
    // ранние строки того же item, ещё не привязанные к id (source_observed
    // /signal_normalized/risk_classified/geo_matched — до вставки в external_alerts).
    values.push(entityId);
    conditions.push(`(
      entity_id = $${values.length}
      OR payload_hash IN (
        SELECT payload_hash FROM safety_decision_events
        WHERE entity_id = $${values.length} AND payload_hash IS NOT NULL
      )
    )`);
  }
  if (eventType) {
    values.push(eventType);
    conditions.push(`event_type = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit);

  try {
    const { rows } = await pool.query<LedgerEventRow>(
      `SELECT id::text, entity_type, entity_id, event_type,
              occurred_at::text, actor_type, actor_id, source_url,
              payload_hash, prior_event_id::text, decision_reason, details,
              created_at::text
       FROM safety_decision_events
       ${where}
       ORDER BY id DESC
       LIMIT $${values.length}`,
      values,
    );
    return NextResponse.json({ events: rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Ошибка БД' },
      { status: 500 },
    );
  }
}
