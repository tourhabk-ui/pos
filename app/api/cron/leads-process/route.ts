/**
 * GET /api/cron/leads-process
 * Обрабатывает новые лиды которые не получили AI-обработку (слетели, ошибки).
 *
 * Запуск: cron-job.org каждые 30 минут
 *   URL: https://vedarai.ru/api/cron/leads-process?secret=<CRON_SECRET>
 *
 * Выбирает: статус 'new', старше 2 минут (чтобы авто-триггер из POST уже отработал), макс 10 за раз
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { leadProcessor } from '@/lib/services/operators/lead-processor.service';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { WIDGET_CHAT_PSEUDO_LEAD_SQL } from '@/lib/leads/widget-chat-pseudo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(secret, cronSecret)) return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });

  const lease = await claimCronWindow('leads-process', 30, 'external');
  if (!shouldRun(lease)) return NextResponse.json(leaseSkipBody('leads-process', 30));

  // Отметка прогона в agent_run_history под ключом реестра 'leads' (аудит
  // 15.10, P4-07): до этого Watchdog видел только след — лиды старше 2 ч, —
  // а не то, что сам крон перестал запускаться. Пропуск по аренде отметки
  // не пишет: окно отрабатывает другой планировщик, и отметит он.
  const t0 = Date.now();

  // Лиды 'new' старше 2 минут, без processed_at, с достаточным качеством.
  // Псевдолиды чата виджета (до 15.10) — не подбор тура: телефона и согласия
  // нет, предложение отправить некому. Скоринг давал им не меньше 30 (имя
  // «Widget: …» с пробелом — 25, пустой телефон — 5), то есть processed_at
  // оставался пустым, а отказ модели возвращает лид в `new` — и конвейер
  // тратил на него вызовы модели каждые полчаса (аудит 15.10, W3-pseudo).
  let rows: Array<{ id: string; name: string }>;
  try {
    ({ rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM leads
       WHERE status = 'new'
         AND created_at < NOW() - INTERVAL '2 minutes'
         AND processed_at IS NULL
         AND (ai_score IS NULL OR ai_score >= 30)
         AND NOT ${WIDGET_CHAT_PSEUDO_LEAD_SQL}
       ORDER BY created_at ASC
       LIMIT 10`
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code ?? 'нет';
    console.error(`[leads-process] выборка лидов не выполнилась (SQLSTATE ${code}):`, message);
    recordCronRun('leads', t0, 'failed', { error: `выборка лидов: ${code} ${message}`.slice(0, 300) });
    return NextResponse.json({ ok: false, error: 'Выборка лидов не выполнилась' }, { status: 500 });
  }

  if (rows.length === 0) {
    recordCronRun('leads', t0, 'success', { items: 0 });
    return NextResponse.json({ ok: true, processed: 0, message: 'Нет необработанных лидов' });
  }

  const results: { id: string; name: string; ok: boolean; error?: string }[] = [];

  for (const lead of rows) {
    try {
      await leadProcessor.process(lead.id);
      results.push({ id: lead.id, name: lead.name, ok: true });
    } catch (err) {
      results.push({
        id: lead.id,
        name: lead.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const processed = results.filter(r => r.ok).length;
  const failed    = results.filter(r => !r.ok).length;

  // Ни одного разобранного при непустой выборке — отказ, а не успех (§4.0).
  // Частичный разбор — успех с названным остатком.
  recordCronRun('leads', t0, processed === 0 ? 'failed' : 'success', {
    items: processed,
    error: failed > 0 ? `не обработано ${failed} из ${rows.length}` : undefined,
  });

  return NextResponse.json({ ok: true, processed, failed, results });
}
