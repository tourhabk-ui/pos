/**
 * GET /api/cron/vision-probe[?deepseek_model=<id>]
 * Authorization: Bearer <CRON_SECRET>
 *
 * Отвечает на вопрос, который до сих пор задавали туристы: ПОЧЕМУ Кузьмич не
 * разбирает фото — и на второй, новый: годится ли DeepSeek четвёртой ступенью.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * На проде водопад зрения молчал целиком: Gemini (нативный и через OpenRouter)
 * гео-блокируется из РФ, Qwen-VL отвечает отказом по ключу DashScope. Снаружи
 * это выглядело одной фразой «фото не вижу» — одинаковой и для «мы не
 * настроены», и для «провайдер нас отверг», и для «сеть не дошла». Причина
 * терялась в трёх пустых `catch` (§4.0). Теперь ступени возвращают исход и
 * причину, а проба их печатает.
 *
 * ── Почему синтетический снимок, а не настоящий ────────────────────────────
 *
 * Вопрос пробы — «работает ли путь», а не «хорошо ли модель узнаёт вулканы».
 * 310-байтный PNG (красный круг на белом) отвечает на первый и не тратит
 * трафик на второй. Снимок вшит в код и не меняется: проба обязана давать
 * сравнимый ответ от прогона к прогону.
 *
 * ── Третий исход есть и здесь ──────────────────────────────────────────────
 *
 * `answers_but_blind` — отдельное состояние, не успех: ступень ответила
 * текстом, но цвета не назвала, то есть снимок до модели не дошёл или был
 * проигнорирован. Без этой проверки «HTTP 200 и непустой текст» сошёл бы за
 * работающее зрение — а это ровно та подмена, из-за которой сторожа перестают
 * ловить. `could_not_check` — ни одна ступень не дала ответа ПРО СЕБЯ (все
 * сетевые отказы): это «не смог проверить», а не «зрения нет».
 *
 * Только чтение: ни одной записи в БД, ни одного поста наружу.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { callVisionDetailed, type VisionLeg } from '@/lib/ai/providers';
import { runPlace } from '@/lib/ai/key-identity';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Красный круг на белом, 64x64, 310 байт. Вшит намеренно: снимок, который
 * меняется от прогона к прогону, делает ответы несравнимыми.
 */
const PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAA/UlEQVR42u2a7RHDIAxDE11WyATd'
  + 'f6ROkCHoBgRsg0URf3snvReca77OUsqx8sKx+JKABCQggdx1hSd+77vy6+d5YuvOqD+yOvc4E69A'
  + 'L3e4CXLp/SHGHQhBD9kKkNCbY0FCbw4HD72tAlT0hiKw0ffWgZC+q3SDi7mUw99eDVr6RgDdDzAL'
  + 'pM9PC4ZGiFaAZH5eYTRCEpCABCQggf8UCH8K61kVGI0QswDJFNUxNELkAulT9AoAf0Qi/TbnQMom'
  + 'NJYiNm4yfd8ITXPoKsK46An0lpN4qIMhHHNqxsW63tRHPfzyHBFkFUeFbP+xR68J7+c2upyWgAQk'
  + 'IIEl1w9THm9jCsedewAAAABJRU5ErkJggg==';

const PROBE_PROMPT = 'Какого цвета фигура на этом изображении? Ответь одним словом.';

/** Ответ, в котором есть корень «красн», означает, что снимок дошёл до модели. */
const SAW_RED = /красн/i;

type Verdict = 'vision_works' | 'answers_but_blind' | 'no_leg_works' | 'could_not_check';

function verdictOf(text: string | null, legs: VisionLeg[]): Verdict {
  if (text) return SAW_RED.test(text) ? 'vision_works' : 'answers_but_blind';
  // Ни одна ступень не ответила. Различаем «провайдеры сказали нам нет» от
  // «мы до них не дошли»: первое — факт о доступе, второе — о сети.
  const spoke = legs.some((l) => l.outcome === 'refused' || l.outcome === 'empty');
  return spoke ? 'no_leg_works' : 'could_not_check';
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Не авторизовано', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  // Имя модели DeepSeek приходит параметром, а не лежит в коде: §8 запрещает
  // хардкод id, а «зрение» каталог провайдера никак не помечает — выбрать
  // сильнейшую автоматически тут не из чего. Не передали — ступень честно
  // пропускается, и это видно в ответе.
  const deepseekModel = req.nextUrl.searchParams.get('deepseek_model') ?? undefined;

  const started = Date.now();
  const { text, legs } = await callVisionDetailed(
    PROBE_PNG_BASE64,
    'image/png',
    PROBE_PROMPT,
    deepseekModel ? { deepseekModel } : {},
  );

  const verdict = verdictOf(text, legs);

  return NextResponse.json({
    verdict,
    /** Какая ступень ответила. null — ни одна. */
    answered_by: legs.find((l) => l.outcome === 'ok')?.provider ?? null,
    /** Назвала ли модель цвет. null — отвечать было нечему. */
    saw_red: text ? SAW_RED.test(text) : null,
    answer: text,
    legs,
    deepseek_model_asked: deepseekModel ?? null,
    run_place: runPlace(),
    ms: Date.now() - started,
    checked_at: new Date().toISOString(),
  });
}
