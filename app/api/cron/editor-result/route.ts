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
 *  - текст проходит ту же проверку правды, что у прод-пути
 *    (`judgeGeneratedDescription`): числа, опасности и содержательные слова
 *    только из источника, голос справки, без рекламных эпитетов. Раннер —
 *    другая модель, но правило записи одно;
 *  - запись должна БЫТЬ в очереди на описание — иначе раннер мог бы переписать
 *    любую строку базы, прислав чужой id;
 *  - происхождение пишется рядом с текстом (`description_provenance`), и в нём
 *    видно, что писал раннер, а не прод: `editor-ai-runner`. Без этого
 *    машинный текст неотличим от текста из источника, а два пути — друг от
 *    друга;
 *  - «не описал» тоже записывается (миграция 1322): id, на которые модель
 *    ответила «НЕТ» (`declined`), и тексты, отвергнутые проверкой правды,
 *    уходят на отдых, иначе завтра очередь отдала бы их снова.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import {
  findRoutesNeedingDescription, buildFacts, recordEditorNoWrite, MIN_GENERATION_LENGTH, type RouteRow,
} from '@/lib/agents/editor';
import { logAgentRun } from '@/lib/agents/run-logger';
import { judgeGeneratedDescription } from '@/lib/agents/editor-truth-gate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  /** Чем написано — для журнала происхождения, а не для доверия. */
  model: z.string().min(1).max(120),
  /**
   * Пустой список РАЗРЕШЁН, и это не недосмотр.
   *
   * Находка 29.09: Watchdog сообщил «Editor (раннер) — прогон не отмечался
   * 181ч», а раннер всё это время исправно шёл каждые сутки. Очередь описаний
   * пуста (Editor её дописал), раннеру нечего было публиковать, и он выходил
   * не позвав прод ВООБЩЕ. Своей строки в истории прогон не оставлял — а
   * единственная отметка раннера на проде вот здесь, ниже. Снаружи «сходил и
   * работы не нашлось» было неотличимо от «не запускался неделю».
   *
   * Поэтому пустой прогон приходит сюда тоже: «делать было нечего» — такой же
   * исход, как «написал три описания», и сказать его нужно вслух (§4.0).
   */
  items: z.array(z.object({
    id: z.string().uuid(),
    description: z.string().min(1).max(5000),
  })).max(20),
  /** id, на которые модель ответила «НЕТ»: из фактов нечего написать (23.10). */
  declined: z.array(z.string().uuid()).max(20).optional(),
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
  const declinedIds = [...new Set(parsed.data.declined ?? [])];

  // Очередь — она же список разрешённых к записи. Раннер получил её из
  // editor-job; здесь проверяем заново, потому что между запросом и ответом
  // прошло время, а доверять присланному id нельзя. Проверяются ровно
  // присланные id: случайная пачка из очереди длиннее пачки их бы не
  // содержала, и описанное раннером отвергалось как «нет в очереди».
  const started_at = new Date();
  const runnerBy = `editor-ai-runner:${model}`.slice(0, 120);

  let queue: RouteRow[];
  try {
    queue = await findRoutesNeedingDescription([...new Set([...items.map((i) => i.id), ...declinedIds])]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[editor-result] очередь не прочиталась:', msg);
    return NextResponse.json({ ok: null, error: `очередь не прочиталась: ${msg}` }, { status: 500 });
  }
  const byId = new Map(queue.map((r) => [r.id, r]));

  let written = 0;
  const rejected: Array<{ id: string; reason: string }> = [];
  let noWriteNoteFailed = 0;
  const noteNoWrite = async (route: RouteRow, outcome: 'declined' | 'truth_rejected', reason: string) => {
    try {
      await recordEditorNoWrite(route, outcome, reason, runnerBy, buildFacts(route).length);
    } catch (err) {
      // Без отметки запись вернётся завтра — не беда, но и не молча.
      noWriteNoteFailed += 1;
      console.error('[editor-result] отметка «не описал» не записана:', route.id,
        err instanceof Error ? err.message : 'unknown');
    }
  };

  let declinedNoted = 0;
  for (const id of declinedIds) {
    const route = byId.get(id);
    if (!route) continue; // уже не в очереди — отдыхать нечему
    await noteNoWrite(route, 'declined', 'модель: из фактов нечего написать');
    declinedNoted += 1;
  }

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
    // Прежний текст — собственный текст модели или пустота (очередь Editor,
    // 23.10): источником для проверки он не служит.
    const verdict = judgeGeneratedDescription(text, {
      facts: buildFacts(route), title: route.title, previous: null,
    });
    if (!verdict.ok) {
      rejected.push({ id: item.id, reason: `проверка правды: ${verdict.reasons.join('; ')}` });
      await noteNoWrite(route, 'truth_rejected', verdict.reasons.join('; '));
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
        [route.id, route.kind ?? 'unknown', route.title, runnerBy,
         JSON.stringify(facts), facts.length, text.length, route.description?.length ?? null],
      );
    } catch (err) {
      // Журнал происхождения не отменяет описание, но и не молчит.
      console.error('[editor-result] происхождение не записано:', route.id,
        err instanceof Error ? err.message : 'unknown');
    }
    written += 1;
  }

  // Прогон раннера обязан оставить СВОЮ строку в истории.
  //
  // Находка аудита 08.09: у записи `editor-runner` в реестре кронов стоял
  // `agentId: 'editor'` — тот же, что у прод-крона. Комментарий там прямо
  // объявлял цель: «молчание любой из них должно быть видно отдельно», — но
  // при общем идентификаторе живость раннера читалась по прогонам ПРОДА.
  // Раннер мог молчать неделями, а сторож видел зелёное. Своей строки он при
  // этом не писал вовсе: единственная его отметка в проде — вот этот запрос.
  void logAgentRun({
    agent_id: 'editor-runner',
    // Отвергнутое — не «немного мусора»: это работа модели, которую не
    // приняли. Ноль записанных при непустом ответе — отказ, а не успех.
    status: written === 0 && items.length > 0 ? 'failed'
      : rejected.length > 0 ? 'partial'
      : 'success',
    started_at,
    duration_ms: Date.now() - started_at.getTime(),
    items_processed: items.length,
    items_created: written,
    errors_count: rejected.length,
    error_msg: rejected.length > 0
      ? `отвергнуто ${rejected.length}: ${rejected.slice(0, 3).map((r) => r.reason).join('; ')}`
      : undefined,
    metadata: {
      model, declined: declinedIds.length, declined_noted: declinedNoted,
      no_write_note_failed: noWriteNoteFailed, rejected: rejected.slice(0, 10),
    },
  });

  return NextResponse.json({
    ok: true,
    written,
    // Отвергнутое называется поимённо: «принято 3 из 5» без причин — это
    // потеря работы модели без следа.
    rejected,
    declined: declinedIds.length,
    declined_noted: declinedNoted,
  });
}
