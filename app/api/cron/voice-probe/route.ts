/**
 * GET /api/cron/voice-probe[?model=<id>&voice=<имя>]
 * Authorization: Bearer <CRON_SECRET>
 *
 * Может ли Кузьмич говорить голосом через наш ключ DashScope (issue #1992).
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Озвучка ответа на маршруте нужна тому, кто не может смотреть в экран. Путь
 * через Qwen дешёв по нашим меркам: провайдер уже подключён, и текст ответа
 * он уже видел — его сочиняет та же модель. Но из контейнера разработки
 * DashScope не спросить, а строить кнопку на непроверенной посылке — это
 * объявленный исход без источника (CLAUDE.md §10.09): кнопка есть, голоса
 * нет никогда, и узнать об этом неоткуда. Сначала проба, потом кнопка.
 *
 * ── Что проба делает ───────────────────────────────────────────────────────
 *
 * 1. Каталог: какие модели синтеза речи видит НАШ ключ (`/models`, признак
 *    `tts` в имени). Модель в коде не зашита — §8: id берутся из каталога.
 *    Параметр `model` — ручной выбор, если каталог назовёт несколько.
 * 2. Синтез короткой русской фразы с названиями мест Камчатки. Не больше
 *    двух моделей за прогон: проба не должна перебирать весь каталог за наш
 *    счёт.
 * 3. Приговор — по ПОЛУЧЕННЫМ БАЙТАМ АУДИО, а не по HTTP 200. Ответ «успех»
 *    без звука — отдельное состояние (`answers_without_audio`), не голос.
 *
 * Качество русской речи автомат не судит: ссылка на аудио уходит в ответ,
 * и слушает её человек. Ссылка ведёт на файл тестовой фразы и живёт сутки.
 *
 * ── Исходы ─────────────────────────────────────────────────────────────────
 *
 *   speaks                 — аудио получено и скачано, байты есть
 *   answers_without_audio  — провайдер ответил, звука нет
 *   refused                — провайдер ответил отказом (текст отказа в ответе)
 *   no_tts_models          — каталог прочитан, моделей синтеза в нём нет
 *   could_not_check        — ключа нет или до провайдера не дошли (§4.0:
 *                            «не смог» не равно «голоса нет»)
 *
 * Только чтение: ни одной записи в БД, ни одного поста наружу.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getQwenConfig } from '@/lib/ai/providers';
import { runPlace } from '@/lib/ai/key-identity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** Фраза вшита: от прогона к прогону ответ обязан быть сравнимым. */
export const PROBE_PHRASE =
  'Проверка голоса Кузьмича. Вулкан Авачинский, Курильское озеро, Петропавловск-Камчатский.';

/** Не больше двух моделей за прогон — проба не перебирает каталог за наш счёт. */
export const MAX_SYNTH_ATTEMPTS = 2;

/**
 * Вторую модель не зовём, если прошло больше этого: curl в prod-check ждёт
 * 60 секунд, и оборванный ответ не отдал бы даже того, что уже узнано.
 */
const SECOND_ATTEMPT_DEADLINE_MS = 25_000;

/** Меньше этого — не речь, а заголовок файла или пустышка. */
const MIN_AUDIO_BYTES = 1000;

/** Сколько байт тела отказа уходит в ответ — достаточно для текста ошибки. */
const ERROR_HEAD = 400;

export type VoiceVerdict = 'speaks' | 'answers_without_audio' | 'refused' | 'no_tts_models' | 'could_not_check';

type Attempt = {
  model: string;
  http: number | null;
  outcome: 'audio' | 'no_audio' | 'refused' | 'network';
  audio_url: string | null;
  audio_bytes: number | null;
  audio_content_type: string | null;
  error: string | null;
  ms: number;
};

/**
 * Нативный API DashScope живёт на том же хосте, что OpenAI-совместимый, без
 * хвоста `/compatible-mode/v1`. Хост берётся из того же QWEN_BASE_URL, что
 * уже работает на тексте: другой регион значил бы другой ключ.
 */
export function nativeBase(compatBase: string): string {
  return compatBase.replace(/\/compatible-mode\/v1$/, '');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readCatalog(base: string, apiKey: string): Promise<
  { ok: true; tts: string[]; total: number } | { ok: false; http: number | null; error: string }
> {
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, http: res.status, error: (await res.text()).slice(0, ERROR_HEAD) };
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    return { ok: true, tts: ids.filter((id) => /tts/i.test(id)).sort(), total: ids.length };
  } catch (err) {
    return { ok: false, http: null, error: errText(err) };
  }
}

/** Достаёт ссылку или base64 аудио из ответа, не угадывая форму заранее. */
function audioOf(body: unknown): { url: string | null; data: string | null } {
  const audio = (body as { output?: { audio?: { url?: unknown; data?: unknown } } })?.output?.audio;
  return {
    url: typeof audio?.url === 'string' && audio.url ? audio.url : null,
    data: typeof audio?.data === 'string' && audio.data ? audio.data : null,
  };
}

async function synthesize(native: string, apiKey: string, model: string, voice: string): Promise<Attempt> {
  const started = Date.now();
  const base: Omit<Attempt, 'ms'> = {
    model, http: null, outcome: 'network', audio_url: null, audio_bytes: null, audio_content_type: null, error: null,
  };
  let res: Response;
  try {
    res = await fetch(`${native}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: { text: PROBE_PHRASE, voice, language_type: 'Russian' } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ...base, error: errText(err), ms: Date.now() - started };
  }
  const raw = await res.text();
  if (!res.ok) {
    return { ...base, http: res.status, outcome: 'refused', error: raw.slice(0, ERROR_HEAD), ms: Date.now() - started };
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* форма ответа названа ниже словами */ }
  const { url, data } = audioOf(body);

  if (data) {
    const bytes = Buffer.from(data, 'base64').length;
    return {
      ...base, http: res.status, outcome: bytes >= MIN_AUDIO_BYTES ? 'audio' : 'no_audio',
      audio_bytes: bytes, error: bytes >= MIN_AUDIO_BYTES ? null : 'аудио короче порога',
      ms: Date.now() - started,
    };
  }
  if (!url) {
    return {
      ...base, http: res.status, outcome: 'no_audio',
      error: body === null ? `ответ не JSON: ${raw.slice(0, ERROR_HEAD)}` : `в ответе нет output.audio: ${raw.slice(0, ERROR_HEAD)}`,
      ms: Date.now() - started,
    };
  }

  // Ссылка сама по себе не звук: скачиваем и меряем.
  try {
    const audioRes = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const bytes = audioRes.ok ? (await audioRes.arrayBuffer()).byteLength : 0;
    const ok = audioRes.ok && bytes >= MIN_AUDIO_BYTES;
    return {
      ...base, http: res.status, outcome: ok ? 'audio' : 'no_audio',
      audio_url: url, audio_bytes: bytes, audio_content_type: audioRes.headers.get('content-type'),
      error: ok ? null : `ссылка на аудио ответила HTTP ${audioRes.status}, байт ${bytes}`,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ...base, http: res.status, outcome: 'network', audio_url: url, error: `аудио не скачалось: ${errText(err)}`, ms: Date.now() - started };
  }
}

export function verdictOf(catalogOk: boolean, ttsCount: number, attempts: Attempt[]): VoiceVerdict {
  if (attempts.some((a) => a.outcome === 'audio')) return 'speaks';
  if (attempts.some((a) => a.outcome === 'no_audio')) return 'answers_without_audio';
  if (attempts.some((a) => a.outcome === 'refused')) return 'refused';
  if (catalogOk && ttsCount === 0 && attempts.length === 0) return 'no_tts_models';
  return 'could_not_check';
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(req), cronSecret)) {
    return NextResponse.json({ error: 'Не авторизовано', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  const started = Date.now();
  const { apiKey, base } = getQwenConfig();
  const params = req.nextUrl.searchParams;
  // Имя голоса — параметром: какие голоса знает модель, каталог не говорит,
  // и провайдер при неверном имени ответит отказом, который попадёт в ответ.
  const voice = (params.get('voice') ?? 'Cherry').slice(0, 40);
  const askedModel = params.get('model')?.slice(0, 80) ?? null;

  if (!apiKey) {
    return NextResponse.json({
      verdict: 'could_not_check' satisfies VoiceVerdict,
      reason: 'DASHSCOPE_API_KEY не задан',
      run_place: runPlace(),
      checked_at: new Date().toISOString(),
    });
  }

  const catalog = await readCatalog(base, apiKey);
  const ttsModels = catalog.ok ? catalog.tts : [];
  const candidates = (askedModel ? [askedModel] : ttsModels).slice(0, MAX_SYNTH_ATTEMPTS);

  const native = nativeBase(base);
  const attempts: Attempt[] = [];
  for (const model of candidates) {
    if (attempts.length > 0 && Date.now() - started > SECOND_ATTEMPT_DEADLINE_MS) break;
    const attempt = await synthesize(native, apiKey, model, voice);
    attempts.push(attempt);
    if (attempt.outcome === 'audio') break;
  }

  const verdict = verdictOf(catalog.ok, ttsModels.length, attempts);
  if (verdict !== 'speaks') {
    // Не голос — причина в лог, а не только в ответ (§4.0: отказ не глушится).
    console.error('[voice-probe] голоса нет:', verdict, attempts.map((a) => `${a.model}:${a.outcome}:${a.http}`).join(', '));
  }

  return NextResponse.json({
    verdict,
    phrase: PROBE_PHRASE,
    voice,
    model_asked: askedModel,
    catalog: catalog.ok
      ? { read: true, total_models: catalog.total, tts_models: catalog.tts }
      : { read: false, http: catalog.http, error: catalog.error },
    attempts,
    /** Слушать ушами: качество русской речи автомат не судит. */
    listen: attempts.find((a) => a.outcome === 'audio')?.audio_url ?? null,
    compat_base: base,
    native_base: native,
    run_place: runPlace(),
    ms: Date.now() - started,
    checked_at: new Date().toISOString(),
  });
}
