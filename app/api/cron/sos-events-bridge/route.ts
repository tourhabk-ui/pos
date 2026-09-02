/**
 * GET /api/cron/sos-events-bridge
 *
 * Polls sos_events table for recent entries (last 35 min)
 * and emits SOS_CRITICAL events to the agent event bus.
 *
 * This bridges the protected SOS endpoint (DO NOT MODIFY)
 * to the agent system without modifying the SOS API.
 *
 * Запускать: каждые 30 минут (aligns with rescue agent schedule)
 * Защита: ?secret=CRON_SECRET
 *
 * cron-job.org:
 *   https://vedarai.ru/api/cron/sos-events-bridge?secret=SECRET
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { emitEvent, AGENT_EVENTS } from '@/lib/events/emit';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';

export const dynamic = 'force-dynamic';

interface SosEventRow {
  id: string;
  lat: string | null;
  lng: string | null;
  status: string;
  notes: string | null;
  created_at: Date;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);

  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Неавторизованный доступ', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  // Без аренды два планировщика в одном окне выпустили бы ОДНО SOS-событие
  // в шину дважды — а на том конце это второй наряд по одному сигналу.
  const lease = await claimCronWindow('sos-events-bridge', 30, 'external');
  if (!shouldRun(lease)) return NextResponse.json(leaseSkipBody('sos-events-bridge', 30));

  const startedAt = Date.now();

  try {
    // Снятие с активной тревоги сигналов старше 24 часов.
    //
    // Раньше здесь стояло ТОЛЬКО `status = 'resolved'` — и это была неправда
    // в самом опасном месте платформы. «Resolved» читается как «с человеком
    // всё в порядке»; на деле означало обратное: сутки никто не пришёл, и
    // что стало с человеком, неизвестно. Самый громкий из возможных отказов
    // записывался как успех, после чего Watchdog про него навсегда замолкал.
    //
    // Снимать с получасовой тревоги через сутки правильно: звонить 112 по
    // вчерашнему сигналу без координат нечего. Но исход обязан называться
    // своим именем — для этого outcome (миграция 928). Статус не трогаем
    // сверх прежнего: на нём висят другие чтения, и CHECK у таблицы нам
    // неизвестен (sos_events вне реестра схемы).
    const { rowCount: archived } = await pool.query(
      `UPDATE sos_events
       SET status = 'resolved',
           outcome = 'unknown_no_response',
           outcome_at = NOW(),
           notes = COALESCE(notes || ' | ', '')
                   || 'Снят с тревоги через 24ч: никто не ответил, исход НЕИЗВЕСТЕН'
       WHERE status = 'sent'
         AND created_at < NOW() - INTERVAL '24 hours'`
    );

    // Check for SOS events in last 35 minutes (runs every 30 min, 5 min overlap)
    const { rows } = await pool.query<SosEventRow>(
      `SELECT id::text, lat::text, lng::text, status, notes, created_at
       FROM sos_events
       WHERE created_at > NOW() - INTERVAL '35 minutes'
       ORDER BY created_at DESC`
    );

    let emittedCount = 0;
    for (const sos of rows) {
      emitEvent(AGENT_EVENTS.SOS_CRITICAL, 'sos_bridge', 'critical', {
        sosId: sos.id,
        lat: sos.lat ? parseFloat(sos.lat) : null,
        lng: sos.lng ? parseFloat(sos.lng) : null,
        status: sos.status,
        notes: sos.notes?.slice(0, 200) ?? null,
        createdAt: sos.created_at.toISOString(),
      });
      emittedCount++;
    }

    recordCronRun('sos-bridge', startedAt, 'success', { items: emittedCount });
    return NextResponse.json({
      success: true,
      data: { sosEventsProcessed: emittedCount, staleArchived: archived ?? 0 },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
    recordCronRun('sos-bridge', startedAt, 'failed', { error: message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
