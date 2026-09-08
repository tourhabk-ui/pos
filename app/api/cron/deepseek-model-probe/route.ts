/**
 * GET /api/cron/deepseek-model-probe?candidate=<id>&runs=2
 * Authorization: Bearer <CRON_SECRET>
 *
 * Отвечает на ОДИН вопрос: стоит ли менять модель DeepSeek на живом пути
 * Кузьмича — и отвечает ЗАМЕРОМ, а не пересказом анонса.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * 08.09 DeepSeek открыл внутреннее тестирование промежуточной версии
 * (`deepseek-v4.1-flash-expires-on-0910`): по анонсу — та же цена, что у
 * `deepseek-v4-flash`, и около 400 tok/s. Именно в этот день DeepSeek стал
 * ПЕРВИЧНЫМ в водопаде инструментов Кузьмича — на месте снятого Qwen, — то
 * есть речь о скорости ровно там, где ответа ждёт человек в поле.
 *
 * Анонс — не замер. «Около 400 tok/s» измерено не у нас, не с нашего прода и
 * не на наших промптах; между нами и DeepSeek лежит сеть из РФ. Переключать
 * живой путь по чужой цифре — это и есть то самое «заполнить пустое место
 * догадкой», от которого §4.0.
 *
 * ── Почему проба, а не переключение с последующим наблюдением ──────────────
 *
 * Наблюдать пришлось бы по жалобам туристов. Проба стоит два запроса и даёт
 * ответ до того, как кто-то ждёт на плохой связи.
 *
 * ── Почему id приходит параметром, а не лежит в коде ───────────────────────
 *
 * Имя кандидата содержит ДАТУ ПРОТУХАНИЯ (`...-expires-on-0910`). Прибить его
 * в исходник значило бы завести код, который заведомо станет ложью 10.09, —
 * и вдобавок нарушить §8 (не хардкодить id моделей: сильнейшую берут из
 * `/v1/models`). Поэтому кандидат — параметр, а база сравнения приходит из
 * каталога провайдера.
 *
 * SSRF тут нет: адрес — литерал `api.deepseek.com`, из запроса приходит
 * только значение поля `model` в JSON-теле, и оно сужено до строгого набора
 * символов. Ни хост, ни путь, ни заголовки от вызывающего не зависят.
 *
 * ── Три исхода на модель, не два (§4.0) ────────────────────────────────────
 *
 * `ok` — ответила, есть чем мерить. `refused` — провайдер ответил отказом
 * (модели нет, доступа нет, лимит); это ответ ПРО МОДЕЛЬ, и он не путается с
 * `unreachable` — сетевым отказом, который про модель не говорит ничего.
 * Пустой ответ при HTTP 200 — тоже не успех: мерить нечего.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { probeProviderModels } from '@/lib/ai/providers';
import { runPlace } from '@/lib/ai/key-identity';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const DEEPSEEK_CHAT = 'https://api.deepseek.com/v1/chat/completions';

/**
 * Допустимое имя модели. Строго и коротко: буквы, цифры, точка, дефис,
 * подчёркивание. Точка нужна («v4.1»), слэш и двоеточие — нет.
 *
 * Это НЕ защита от SSRF (адрес и так литерал), а защита от того, чтобы в
 * ответ и в лог не уехала произвольная строка вызывающего.
 */
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Вопрос замера. Короткий и одинаковый для всех моделей — иначе сравнивать нечего. */
const PROMPT = [
  { role: 'system' as const, content: 'Ты помощник по Камчатке. Отвечай кратко и по делу, на русском.' },
  { role: 'user' as const, content: 'Турист в сентябре идёт на Авачинский. Назови три вещи, которые обязательно взять.' },
];

export type ModelOutcome = 'ok' | 'refused' | 'unreachable' | 'empty';

export interface ModelMeasurement {
  model: string;
  outcome: ModelOutcome;
  http_status: number | null;
  /** Полное время запроса, мс. Столько ждёт человек, а не «время генерации». */
  latency_ms: number;
  /** Токенов в ответе по данным провайдера. null — провайдер не сказал. */
  completion_tokens: number | null;
  /**
   * Скорость выдачи, токенов в секунду. null, если считать не из чего.
   * Считается по ПОЛНОЙ задержке, включая сеть до РФ: анонсные 400 tok/s
   * измерены не отсюда, и сравнивать надо то, что достаётся нам.
   */
  tokens_per_sec: number | null;
  /** Первые слова ответа — глазами видно, что модель отвечала по делу. */
  answer_preview: string | null;
  /** Отказ провайдера дословно (обрезанный). Пустой при успехе. */
  detail: string | null;
}

/**
 * Скорость выдачи — или честный null.
 *
 * Отдельная чистая функция, потому что здесь легко соврать делением: ноль
 * токенов или нулевая задержка дают либо ноль, либо бесконечность, и обе
 * цифры выглядят как измерение. Их нет — значит null.
 */
export function tokensPerSec(tokens: number | null, latencyMs: number): number | null {
  if (tokens === null || tokens <= 0 || latencyMs <= 0) return null;
  return Math.round((tokens / (latencyMs / 1000)) * 10) / 10;
}

/**
 * Вердикт сравнения — словами, а не «смотри цифры».
 *
 * Отдельно и чисто, потому что именно здесь соблазн выдать желаемое за
 * измеренное. Правила:
 *  — кандидат не ответил → менять нечего, что бы ни обещал анонс;
 *  — база не ответила → сравнивать не с чем, это «не знаю», а не победа;
 *  — разница меньше 15% → шум замера, а не выигрыш: два запроса из РФ
 *    отличаются друг от друга сильнее.
 */
export function compareVerdict(
  candidate: ModelMeasurement | null,
  baseline: ModelMeasurement | null,
): string {
  if (!candidate) return 'кандидат не задан — сравнивать нечего';
  if (candidate.outcome !== 'ok') {
    return `кандидат ${candidate.model} не ответил (${candidate.outcome}) — переключать нечего`;
  }
  if (!baseline || baseline.outcome !== 'ok') {
    return `кандидат ответил за ${candidate.latency_ms} мс, а база сравнения молчит — вывода о выигрыше НЕТ`;
  }
  const gain = (baseline.latency_ms - candidate.latency_ms) / baseline.latency_ms;
  const pct = Math.round(Math.abs(gain) * 100);
  if (Math.abs(gain) < 0.15) {
    return `разница ${pct}% — в пределах шума двух запросов из РФ, оснований переключаться нет`;
  }
  return gain > 0
    ? `кандидат быстрее базы на ${pct}% (${candidate.latency_ms} мс против ${baseline.latency_ms} мс)`
    : `кандидат МЕДЛЕННЕЕ базы на ${pct}% (${candidate.latency_ms} мс против ${baseline.latency_ms} мс)`;
}

/** Один замер одной модели. Ключ уходит только на api.deepseek.com. */
async function measure(model: string, apiKey: string): Promise<ModelMeasurement> {
  const started = Date.now();
  const base: Omit<ModelMeasurement, 'outcome' | 'http_status' | 'latency_ms'> = {
    model,
    completion_tokens: null,
    tokens_per_sec: null,
    answer_preview: null,
    detail: null,
  };

  try {
    const res = await fetch(DEEPSEEK_CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: PROMPT, temperature: 0.3, max_tokens: 300 }),
      signal: AbortSignal.timeout(45_000),
    });
    const latency_ms = Date.now() - started;

    if (!res.ok) {
      return {
        ...base,
        outcome: 'refused',
        http_status: res.status,
        latency_ms,
        detail: (await res.text().catch(() => '')).slice(0, 300),
      };
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { completion_tokens?: number };
    };
    const text = data?.choices?.[0]?.message?.content ?? null;
    const tokens = typeof data?.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : null;

    if (!text?.trim()) {
      // HTTP 200 с пустым телом — не успех: мерить нечего, и выдавать это за
      // рабочую модель значило бы соврать в самую полезную сторону.
      return { ...base, outcome: 'empty', http_status: res.status, latency_ms, completion_tokens: tokens };
    }

    return {
      ...base,
      outcome: 'ok',
      http_status: res.status,
      latency_ms,
      completion_tokens: tokens,
      tokens_per_sec: tokensPerSec(tokens, latency_ms),
      answer_preview: text.trim().slice(0, 160),
    };
  } catch (err) {
    return {
      ...base,
      outcome: 'unreachable',
      http_status: null,
      latency_ms: Date.now() - started,
      detail: err instanceof Error ? err.message : 'запрос не удался',
    };
  }
}

/** Лучший (самый быстрый) успешный замер из серии, либо первый неуспешный. */
export function bestOf(runs: ModelMeasurement[]): ModelMeasurement | null {
  if (runs.length === 0) return null;
  const ok = runs.filter(r => r.outcome === 'ok');
  if (ok.length === 0) return runs[0];
  return ok.reduce((a, b) => (b.latency_ms < a.latency_ms ? b : a));
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const place = runPlace();

  if (!apiKey) {
    // Не «моделей нет», а «спросить нечем». Разные беды, разная починка.
    return NextResponse.json({
      ok: false,
      place,
      error: 'DEEPSEEK_API_KEY не задан — замерить нечем',
    }, { status: 200 });
  }

  const candidateRaw = (request.nextUrl.searchParams.get('candidate') ?? '').trim().toLowerCase();
  const candidate = candidateRaw && MODEL_ID_RE.test(candidateRaw) ? candidateRaw : null;
  const candidateRejected = candidateRaw !== '' && candidate === null;

  const runsRaw = parseInt(request.nextUrl.searchParams.get('runs') ?? '2', 10);
  const runs = Number.isFinite(runsRaw) ? Math.min(Math.max(runsRaw, 1), 3) : 2;

  // Каталог провайдера — и база сравнения, и ответ на вопрос «а есть ли
  // кандидат вообще». Отказ каталога назван отдельно: «моделей не нашли» и
  // «не смогли спросить» — разные ответы (§4.0).
  const catalog = await probeProviderModels('deepseek');
  const ids = catalog.ok ? catalog.ids : [];

  // База сравнения — то, чем живой путь пользуется СЕЙЧАС. Берётся из
  // каталога по имени семейства, а не прибивается: имена у DeepSeek меняются.
  const baselineId = ids.find(id => /flash/i.test(id) && !/expires-on/i.test(id))
    ?? ids.find(id => /chat/i.test(id))
    ?? ids[0]
    ?? null;

  const targets: string[] = [];
  if (candidate) targets.push(candidate);
  if (baselineId && baselineId !== candidate) targets.push(baselineId);

  const measurements: Record<string, ModelMeasurement[]> = {};
  for (const model of targets) {
    measurements[model] = [];
    for (let i = 0; i < runs; i++) {
      measurements[model].push(await measure(model, apiKey));
    }
  }

  const candidateBest = candidate ? bestOf(measurements[candidate] ?? []) : null;
  const baselineBest = baselineId ? bestOf(measurements[baselineId] ?? []) : null;

  return NextResponse.json({
    ok: true,
    place,
    ms: Date.now() - started,
    runs_per_model: runs,
    candidate,
    // Кандидат отклонён по форме имени — говорим об этом, а не молчим: иначе
    // опечатка в id выглядит как «кандидат не задан».
    candidate_rejected: candidateRejected ? candidateRaw.slice(0, 80) : null,
    candidate_in_catalog: candidate ? ids.includes(candidate) : null,
    baseline: baselineId,
    catalog: catalog.ok
      ? { ok: true, count: ids.length, ids }
      : { ok: false, http_status: catalog.http_status, detail: catalog.detail },
    measurements,
    best: { candidate: candidateBest, baseline: baselineBest },
    verdict: compareVerdict(candidateBest, baselineBest),
  });
}
