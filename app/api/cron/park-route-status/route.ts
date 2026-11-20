/**
 * GET /api/cron/park-route-status — статус «открыт / закрыт» утверждённых
 * маршрутов природных парков со страницы парка «Туристические маршруты».
 * Bearer CRON_SECRET. Раз в сутки, шагом в cron-routes-cache.yml.
 *
 * Слово владельца 20.11: «Статус открыт/закрыт», цвета — «Шкала как у
 * KVERT». Статус уходит в оценку дня маршрута (lib/routes/go-verdict:
 * оранжевый — «Осторожно», красный — «Не сегодня») и на карточку, к Кузьмичу
 * и в MCP. Правила и исходы — lib/parks/park-route-status-run.
 *
 * Страница не ответила или строк статуса в ней нет — 502: прежний статус не
 * подтверждается, через трое суток он читается «не проверено». Прочитано
 * частично (строки вне справочника, варианты без строки на странице) — 200 со
 * списками и записью 'partial' в журнале.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { logAgentRun } from '@/lib/agents/run-logger';
import { runParkStatusRead } from '@/lib/parks/park-route-status-run';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeCompare(getCronSecret(request) ?? '', secret)) {
    if (!secret) console.error('[park-route-status] CRON_SECRET не настроен: статус парка не читается');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const started_at = new Date();
  const ms = () => Date.now() - started_at.getTime();
  try {
    const run = await runParkStatusRead();
    if (run.outcome !== 'read') {
      const error = run.outcome === 'fetch_failed'
        ? `страница парка не прочитана: ${run.error}`
        : 'страница парка прочитана, но строк статуса в ней нет — разметка изменилась';
      console.error(`[park-route-status] ${error}`);
      void logAgentRun({
        agent_id: 'park-route-status', status: 'failed', started_at, duration_ms: ms(),
        items_processed: 0, errors_count: 1, error_msg: error.slice(0, 200),
      });
      return NextResponse.json({ success: false, ...run, error }, { status: 502 });
    }
    const partial = run.written === 0 || run.not_in_table.length > 0 || run.not_on_page.length > 0 || run.problems.length > 0;
    void logAgentRun({
      agent_id: 'park-route-status', status: partial ? 'partial' : 'success', started_at, duration_ms: ms(),
      items_processed: run.written,
      errors_count: run.not_in_table.length + run.not_on_page.length + run.problems.length,
      metadata: { parsed: run.parsed, open: run.open.length },
    });
    return NextResponse.json({ success: true, ...run });
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error('[park-route-status] отказ записи:', code ? `SQLSTATE=${code}` : (err instanceof Error ? err.message.slice(0, 200) : 'отказ'));
    void logAgentRun({
      agent_id: 'park-route-status', status: 'failed', started_at, duration_ms: ms(), errors_count: 1,
      error_msg: err instanceof Error ? err.message.slice(0, 200) : 'отказ',
    });
    return NextResponse.json({ error: 'Статус маршрутов парка не записан', sqlstate: code ?? null }, { status: 500 });
  }
}
