import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Действия, которые роут ПРИНИМАЕТ.
 *
 * Список вынесен и экспортирован намеренно: до 23.08 он расходился с тем, что
 * шлёт кнопка. В перечне не было `publish_ai_news`, хотя ветка для него ниже
 * написана целиком — значит кнопка «AI-дайджест» не работала НИ РАЗУ с момента
 * появления: Zod заворачивал запрос до неё и отдавал наружу своё «Invalid
 * input». Владелец видел это на проде 23.08.
 *
 * Почему молчал tsc: две проверки выше сужают тип `body.action` до `never`, а
 * сравнение `never` с литералом язык разрешает. Мёртвая ветка выглядела живой
 * и для человека, и для компилятора. Сторож `intelligence-actions` сверяет
 * этот перечень с тремя вещами разом: ветками роута, вызовами клиента и
 * собой — расхождение любой пары красит сборку.
 */
export const TEST_ACTIONS = ['test_rss', 'run_cycle', 'publish_ai_news'] as const;

const TestSchema = z.object({
  action: z.enum(TEST_ACTIONS),
  // Только http(s) — сервер не должен фетчить file:// и прочие схемы
  url: z.string().url().max(500).refine(u => /^https?:\/\//i.test(u), 'только http(s) URL').optional(),
});

/**
 * POST /api/admin/intelligence-sources/test
 * Test a single RSS URL or trigger a full intelligence cycle
 *
 * Body: { action: 'test_rss', url: string } — test one RSS feed
 * Body: { action: 'run_cycle' } — run full intelligence cycle NOW
 */
export async function POST(request: NextRequest) {
  const authErr = await requireAdmin(request);
  if (authErr instanceof NextResponse) return authErr;

  try {
    const parsed = TestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      // Своё сообщение, а не Zod-овское. «Invalid input» не называет ни поля,
      // ни допустимых значений — по нему нельзя понять ни что сломалось, ни
      // что чинить, и оно ещё и по-английски (CLAUDE.md: ошибки на русском).
      const issue = parsed.error.issues[0];
      const field = issue?.path.join('.') || 'тело запроса';
      const error = field === 'action'
        ? `Неизвестное действие. Роут принимает: ${TEST_ACTIONS.join(', ')}`
        : `Не разобрано поле «${field}»: ${issue?.message ?? 'некорректное значение'}`;
      return NextResponse.json({ success: false, error }, { status: 400 });
    }
    const body = parsed.data;

    if (body.action === 'test_rss') {
      if (!body.url) {
        return NextResponse.json({ success: false, error: 'url is required' }, { status: 400 });
      }
      // Dynamic import to avoid circular deps
      const res = await fetch(body.url, {
        headers: { 'User-Agent': 'TourHab-Intelligence/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return NextResponse.json({
          success: false,
          error: `HTTP ${res.status} ${res.statusText}`,
        });
      }
      const xml = await res.text();
      const isAtom = xml.includes('<entry>');
      const itemCount = (xml.match(isAtom ? /<entry>/gi : /<item>/gi) || []).length;

      return NextResponse.json({
        success: true,
        format: isAtom ? 'atom' : 'rss',
        items_found: itemCount,
        content_length: xml.length,
        sample: xml.substring(0, 500),
      });
    }

    if (body.action === 'run_cycle') {
      const { runIntelligenceCycle } = await import('@/lib/services/intelligence-monitor.service');
      const report = await runIntelligenceCycle();

      return NextResponse.json({
        success: true,
        report: {
          timestamp: report.timestamp,
          raw_signals: report.raw_count,
          findings: report.domains.length,
          duration_ms: report.duration_ms,
          domains: report.domains.map(d => ({
            domain: d.domain,
            urgency: d.urgency,
            summary: d.summary,
            action_items: d.action_items,
          })),
        },
      });
    }

    if (body.action === 'publish_ai_news') {
      const { runIntelligenceCycle } = await import('@/lib/services/intelligence-monitor.service');
      const { postAINewsToChannel } = await import('@/lib/notifications/telegram-channel');

      const report = await runIntelligenceCycle();
      const aiFindings = report.domains.filter(
        d => d.domain === 'ai_tech' && (d.urgency === 'critical' || d.urgency === 'notable')
      );

      const published: Array<{ urgency: string; summary: string; ok: boolean; error?: string }> = [];
      for (const f of aiFindings) {
        const result = await postAINewsToChannel(f);
        published.push({ urgency: f.urgency, summary: f.summary.slice(0, 100), ...result });
      }

      return NextResponse.json({
        success: true,
        total_findings: report.domains.length,
        ai_findings: aiFindings.length,
        published,
      });
    }

    // Недостижимо, пока перечень и ветки сходятся, — и именно это стережёт
    // тест. Сообщение всё равно человеческое: молчаливых тупиков не держим.
    return NextResponse.json(
      { success: false, error: `Действие не обработано роутом. Принимаются: ${TEST_ACTIONS.join(', ')}` },
      { status: 400 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[admin/intelligence-sources/test] failed:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
