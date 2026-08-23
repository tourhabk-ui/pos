/**
 * GET /api/cron/support-escalate
 *
 * Автоэскалация тикетов поддержки зависших более 24 часов.
 * Уведомляет владельца в Telegram.
 *
 * Запускать: каждые 6 часов
 *
 * cron-job.org:
 *   https://vedarai.ru/api/cron/support-escalate?secret=SECRET
 *   → каждые 6 часов
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOverdueTickets, escalateTicket } from '@/lib/support/ticket.service';
import { notifyAdminEscalated } from '@/lib/telegram/admin-notify';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Heartbeat — ПОСЛЕ работы, по её исходу (§4.0).
  const startedAt = Date.now();

  try {
    const overdue = await getOverdueTickets();
    if (overdue.length === 0) {
      recordCronRun('support-escalate', startedAt, 'success', { items: 0 });
      return NextResponse.json({ ok: true, escalated: 0 });
    }

    let escalated = 0;

    for (const ticket of overdue) {
      await escalateTicket(ticket.id, 'Автоэскалация: нет ответа более 24 часов');
      notifyAdminEscalated(ticket, `Нет ответа ${Math.floor((Date.now() - new Date(ticket.updatedAt).getTime()) / 3600_000)}ч`);
      escalated++;
    }

    recordCronRun('support-escalate', startedAt, 'success', { items: escalated });
    return NextResponse.json({ ok: true, escalated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
    console.error('[support-escalate] прогон не удался:', message);
    recordCronRun('support-escalate', startedAt, 'failed', { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
