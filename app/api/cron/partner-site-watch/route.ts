/**
 * GET /api/cron/partner-site-watch — наблюдение за сайтами партнёров.
 * Bearer CRON_SECRET. Раз в сутки, шагом в cron-operator-site-audit.yml.
 *
 * Слово владельца 22.10: «нам нужно проверять сайты партнеров на изменение»;
 * на вопросы — «сообщать мне», «всех с сайтом, сами». Туры партнёров у нас
 * собраны с их сайтов: партнёр поменял у себя цену или снял тур — наша
 * карточка стала неправдой (§0). Здесь читается главная каждого партнёра с
 * сайтом и страницы-источники его туров на витрине, видимый текст сверяется с
 * прошлым разом, и владелец получает в Telegram, что изменилось и какие наши
 * туры задеты. Правила — lib/partners/site-watch.ts, прогон — site-watch-run.ts.
 *
 * Три исхода, а не два (§4.0): «изменилось», «без перемен» и «не смог
 * прочитать» — последний не выдаётся за «без перемен», он пишется снимком и
 * после второго подряд отказа доходит до владельца.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { runSiteWatch } from '@/lib/partners/site-watch-run';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeCompare(getCronSecret(request) ?? '', secret)) {
    if (!secret) console.error('[partner-site-watch] CRON_SECRET не настроен: наблюдение не выполнится');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const started_at = new Date();
  try {
    const result = await runSiteWatch();
    const failed = result.reports.filter((r) => r.outcome === 'failed').length;
    void logAgentRun({
      agent_id: 'partner-site-watch', status: 'success', started_at,
      duration_ms: Date.now() - started_at.getTime(),
      items_processed: result.pages,
      metadata: { events: result.events, failed, notified: result.notified?.ok ?? null },
    });
    return NextResponse.json({
      success: true,
      pages: result.pages,
      // Ноль страниц — не «всё спокойно»: значит, партнёров с сайтом и турами на
      // витрине в базе не нашлось, и наблюдать нечего (§4.0).
      note: result.pages === 0 ? 'ни одной страницы под наблюдением: партнёров с сайтом и турами на витрине не нашлось' : undefined,
      events: result.events,
      notified: result.notified,
      reports: result.reports,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error('[partner-site-watch] отказ:', code ?? (err instanceof Error ? err.message : err));
    void logAgentRun({
      agent_id: 'partner-site-watch', status: 'failed', started_at,
      duration_ms: Date.now() - started_at.getTime(), errors_count: 1,
      error_msg: err instanceof Error ? err.message.slice(0, 200) : 'отказ',
    });
    return NextResponse.json({ error: 'Наблюдение за сайтами партнёров не выполнено', sqlstate: code ?? null }, { status: 500 });
  }
}
