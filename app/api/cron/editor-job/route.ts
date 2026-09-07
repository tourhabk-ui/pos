/**
 * GET /api/cron/editor-job — что писать Editor'у. Bearer CRON_SECRET, ТОЛЬКО ЧТЕНИЕ.
 *
 * Зачем эндпоинт, если Editor и так живёт на проде: с прода недостижим
 * OpenRouter — 403 и напрямую, и через релей (замер 07.09, ответы совпали
 * дословно, значит режет край сети по нашему адресу). Флагманы Claude/GPT
 * оттуда не берутся, и `callAIQuality` намеренно ставит первым DeepSeek.
 *
 * Раннер GitHub не в РФ и OpenRouter достигает — этим путём уже год ходит
 * разбор находок и с 25.08 AI-ревью Growth Scan. Решение владельца 07.09:
 * «OpenRouter переключи на гитхаб».
 *
 * Разделение труда то же, что у evo-review: СПИСОК выбирает прод (он один
 * видит базу — раннер упирается в файрвол БД Timeweb), модель зовёт раннер,
 * готовый текст возвращается на прод через POST /api/cron/editor-result.
 *
 * Отбор — та же `findRoutesNeedingDescription`, не копия: две выборки
 * разошлись бы, и прод с раннером писали бы описания разным записям.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { findRoutesNeedingDescription } from '@/lib/agents/editor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Партия на прогон: раннеру дан потолок времени, а не «сколько найдётся». */
const MAX_ROUTES = 12;

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_ROUTES)
    : MAX_ROUTES;

  try {
    const routes = await findRoutesNeedingDescription();
    return NextResponse.json({
      job: 'editor_job_v1',
      picked_at: new Date().toISOString(),
      // Сколько ЕСТЬ и сколько ОТДАНО — разные числа, и первое не должно
      // теряться: по нему видно, растёт очередь или сокращается.
      queue_total: routes.length,
      routes: routes.slice(0, limit),
    });
  } catch (err) {
    // Пустой список выглядел бы как «писать нечего» — а это другое утверждение
    // (§4.0). Раннер на такой ответ обязан покраснеть, а не отчитаться «чисто».
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[editor-job] выборка не удалась:', msg);
    return NextResponse.json(
      { job: 'editor_job_v1', ok: null, error: `выборка не удалась: ${msg}` },
      { status: 500 },
    );
  }
}
