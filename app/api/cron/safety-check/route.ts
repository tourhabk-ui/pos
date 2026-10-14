/**
 * Cron: синтетическая проверка safety-флоу на живой системе.
 *
 * Прогоняет инварианты безопасности (SOS-детектор, экстренные номера, телефон
 * МЧС на маршрутах, покупаемый тур, профили безопасности) на боевых данных и
 * возвращает отчёт. criticalFail = сломано ядро обещания (турист в ЧП не
 * получит 112) — воркфлоу краснит ран.
 *
 * Read-only: лидов/броней не создаёт. Первый прогон — правкой
 * .github/triggers/safety-check.json в main.
 *
 * Зовут: супервизор start.js (раз в 6 ч, с 14.10) и cron-safety-check.yml.
 * Аренда окна 6 ч: из двух планировщиков в одном окне работает первый, второй
 * получает lease_held без criticalFail, и его воркфлоу зелёный — проверку
 * этого окна уже сделал первый. Поэтому о сломанном ядре сообщает сам роут,
 * в Telegram, кто бы его ни позвал: до 14.10 единственным каналом был
 * красный прогон GitHub, и в окне, занятом супервизором, тревога пропала бы.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runSafetySelfCheck } from '@/lib/safety/safety-selfcheck';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { logAgentRun } from '@/lib/agents/run-logger';
import { claimCronWindow, shouldRun, leaseSkipBody } from '@/lib/agents/cron-lease';
import { tgSend } from '@/lib/notifications/tg-send';
import { escapeHtml } from '@/lib/text/escape-html';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const WINDOW_MIN = 360;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const lease = await claimCronWindow('safety-check', WINDOW_MIN, 'external');
  if (!shouldRun(lease)) return NextResponse.json(leaseSkipBody('safety-check', WINDOW_MIN));

  const started_at = new Date();
  const report = await runSafetySelfCheck();

  const failedWarn = report.checks.filter((c) => c.level === 'warn' && !c.pass).length;
  void logAgentRun({
    agent_id: 'safety-check',
    status: report.criticalFail ? 'failed' : failedWarn > 0 ? 'partial' : 'success',
    started_at,
    duration_ms: Date.now() - started_at.getTime(),
    items_processed: report.checks.length,
    errors_count: report.checks.filter((c) => !c.pass).length,
    error_msg: report.criticalFail
      ? report.checks.filter((c) => c.level === 'critical' && !c.pass).map((c) => `${c.id}: ${c.detail}`).join('; ')
      : undefined,
  });

  if (report.criticalFail) {
    const broken = report.checks.filter((c) => c.level === 'critical' && !c.pass);
    const sent = await tgSend('safety-check', [
      '<b>КРИТИЧНО: самопроверка безопасности</b>',
      'Сломано ядро обещания: турист в ЧП может не получить 112.',
      ...broken.map((c) => `• ${escapeHtml(c.id)}: ${escapeHtml(c.detail)}`),
    ].join('\n'));
    // Исход доставки — в теле: «решили тревожить» не равно «тревога ушла».
    return NextResponse.json({ ...report, alert: sent.ok ? 'sent' : `not_sent: ${sent.reason}` });
  }

  // Всегда HTTP 200, чтобы проба могла прочитать тело; сигнал — в полях
  // ok/criticalFail. Воткфлоу краснит по criticalFail.
  return NextResponse.json(report);
}
