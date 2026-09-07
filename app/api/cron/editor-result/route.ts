/**
 * POST /api/cron/editor-result — описания, написанные раннером GitHub.
 * Bearer CRON_SECRET.
 *
 * Вторая половина пары к /api/cron/editor-job. Модель зовёт раннер (с прода
 * OpenRouter режется по сети — замер 07.09), но ЗАПИСЬ идёт здесь: база
 * доступна только проду, и правила сохранения не должны раздваиваться.
 *
 * Приёмник ничему не верит на слово:
 *  - текст короче порога отвергается тем же `MIN_GENERATION_LENGTH`, что у
 *    прод-пути;
 *  - запись должна БЫТЬ в очереди на описание — иначе раннер мог бы переписать
 *    любую строку базы, прислав чужой id;
 *  - происхождение пишется рядом с текстом (`description_provenance`), и в нём
 *    видно, что писал раннер, а не прод: `editor-ai-runner`. Без этого
 *    машинный текст неотличим от текста из источника, а два пути — друг от
 *    друга.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { findRoutesNeedingDescription, buildFacts, MIN_GENERATION_LENGTH, type RouteRow } from '@/lib/agents/editor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  /** Чем написано — для журнала происхождения, а не для доверия. */
  model: z.string().min(1).max(120),
  items: z.array(z.object({
    id: z.string().uuid(),
    description: z.string().min(1).max(5000),
  })).min(1).max(20),
});

export async function POST(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Тело запроса не прошло проверку', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { model, items } = parsed.data;

  // Очередь — она же список разрешённых к записи. Раннер получил её из
  // editor-job; здесь проверяем заново, потому что между запросом и ответом
  // прошло время, а доверять присланному id нельзя.
  let queue: RouteRow[];
  try {
    queue = await findRoutesNeedingDescription();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[editor-result] очередь не прочиталась:', msg);
    return NextResponse.json({ ok: null, error: `очередь не прочиталась: ${msg}` }, { status: 500 });
  }
  const byId = new Map(queue.map((r) => [r.id, r]));

  let written = 0;
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const item of items) {
    const route = byId.get(item.id);
    if (!route) {
      rejected.push({ id: item.id, reason: 'записи нет в очереди на описание' });
      continue;
    }
    const text = item.description.trim();
    if (text.length < MIN_GENERATION_LENGTH) {
      rejected.push({ id: item.id, reason: `короче порога ${MIN_GENERATION_LENGTH}` });
      continue;
    }

    try {
      await pool.query(
        `UPDATE agent_route_knowledge SET description = $1 WHERE id = $2`,
        [text, route.id],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error('[editor-result] запись описания не удалась:', route.id, msg);
      rejected.push({ id: item.id, reason: `запись не удалась: ${msg}` });
      continue;
    }

    try {
      const facts = buildFacts(route);
      await pool.query(
        `INSERT INTO description_provenance
           (entity_id, entity_kind, entity_title, written_by, facts_given, facts_count, chars, previous_chars)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [route.id, route.kind ?? 'unknown', route.title, `editor-ai-runner:${model}`.slice(0, 120),
         JSON.stringify(facts), facts.length, text.length, route.description?.length ?? null],
      );
    } catch (err) {
      // Журнал происхождения не отменяет описание, но и не молчит.
      console.error('[editor-result] происхождение не записано:', route.id,
        err instanceof Error ? err.message : 'unknown');
    }
    written += 1;
  }

  return NextResponse.json({
    ok: true,
    written,
    // Отвергнутое называется поимённо: «принято 3 из 5» без причин — это
    // потеря работы модели без следа.
    rejected,
    queue_left: Math.max(0, queue.length - written),
  });
}
