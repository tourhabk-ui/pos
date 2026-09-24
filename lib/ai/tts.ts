/**
 * Голос Кузьмича — синтез речи через DashScope (issue #1992).
 *
 * Путь проверен с прода до того, как на нём построили кнопку: проба
 * `/api/cron/voice-probe` 24.09 получила от `qwen3-tts-flash` 349 КБ WAV за
 * 2,9 с. Ключ и хост — те же, что у текста Qwen: другой регион значил бы
 * другой ключ, поэтому нативный адрес выводится из QWEN_BASE_URL, а не
 * заводится вторым env.
 *
 * ── Модель из каталога, не из кода (CLAUDE.md §8) ──────────────────────────
 *
 * Каталог ключа знает 16 моделей синтеза: основную, `-realtime` (поток по
 * вебсокету — не наш протокол), `-instruct` (голос по описанию), `-vc` и `-vd`
 * (клон и дизайн голоса — нужен свой голос, которого у нас нет), и
 * датированные снимки каждой. Берём основную без даты: алиас провайдер
 * двигает сам. Ручной выбор — env QWEN_TTS_MODEL.
 *
 * ── Три исхода, не два ─────────────────────────────────────────────────────
 *
 * `ok` — аудио получено и в нём есть байты; `refused` — провайдер ответил, но
 * звука не дал (текст отказа — в reason); `unavailable` — ключа нет, каталог
 * не прочитан, сеть не дошла. Кнопка на любом «не ok» говорит «не удалось
 * озвучить», а причина уходит в лог: молчание здесь выглядело бы как голос,
 * который просто не включился.
 */

import { getQwenConfig, logSpeechUsage } from '@/lib/ai/providers';
import { recordAiLegFailure, httpFailureReason, errorFailureReason } from '@/lib/ai/failure-trace';
import { plainResponse } from '@/lib/text/plain-response';

/** Голос, на котором путь проверен пробой 24.09. Сменить — env QWEN_TTS_VOICE. */
const DEFAULT_VOICE = 'Cherry';

/** Потолок озвучиваемого текста. Длиннее — режем по границе предложения. */
export const SPEECH_MAX_CHARS = 1200;

/** Меньше этого — не речь, а заголовок файла или пустышка. */
const MIN_AUDIO_BYTES = 1000;

const CATALOG_TTL_MS = 60 * 60 * 1000;

/**
 * Нативный API DashScope живёт на том же хосте, что OpenAI-совместимый, без
 * хвоста `/compatible-mode/v1`. Единственное место этого правила: им пользуются
 * и синтез, и проба голоса.
 */
export function nativeBase(compatBase: string): string {
  return compatBase.replace(/\/compatible-mode\/v1$/, '');
}

/**
 * Основная модель синтеза из каталога: без realtime/instruct/клона/дизайна и
 * без даты в имени. null — в каталоге такой нет, и это надо сказать, а не
 * подставить имя по памяти.
 */
export function pickSpeechModel(ids: string[]): string | null {
  const plain = ids
    .filter((id) => /tts/i.test(id))
    .filter((id) => !/(realtime|instruct|-vc\b|-vc-|-vd\b|-vd-)/i.test(id))
    .filter((id) => !/\d{4}-\d{2}-\d{2}/.test(id))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return plain[0] ?? null;
}

/**
 * Текст ответа → текст для голоса: без разметки и эмодзи (их нельзя
 * произнести), не длиннее потолка. Режем по концу предложения, чтобы голос не
 * обрывался на полуслове, и сообщаем, что озвучено не всё.
 */
export function prepareSpeechText(raw: string, max = SPEECH_MAX_CHARS): { text: string; truncated: boolean } {
  const clean = plainResponse(raw)
    .replace(/https?:\/\/\S+/g, '')          // адрес вслух — шум, а не смысл
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  const head = clean.slice(0, max);
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  const cut = lastStop > max * 0.5 ? head.slice(0, lastStop + 1) : head;
  return { text: cut.trim(), truncated: true };
}

let catalogCache: { at: number; model: string | null } | null = null;

async function resolveSpeechModel(base: string, apiKey: string): Promise<string | null> {
  const forced = process.env.QWEN_TTS_MODEL?.trim();
  if (forced) return forced;
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.model;
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`каталог моделей: HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  const model = pickSpeechModel(ids);
  catalogCache = { at: Date.now(), model };
  return model;
}

/** Только для тестов: каталог кэшируется на час, тесту нужен чистый лист. */
export function resetSpeechCatalogCache(): void {
  catalogCache = null;
}

export type SpeechResult =
  | { status: 'ok'; audio: ArrayBuffer; contentType: string; model: string }
  | { status: 'refused'; reason: string }
  | { status: 'unavailable'; reason: string };

/** Синтезирует уже подготовленный текст. Не бросает. */
export async function synthesizeSpeech(text: string): Promise<SpeechResult> {
  const { apiKey, base } = getQwenConfig();
  if (!apiKey) {
    recordAiLegFailure('qwen-tts', 'no_key');
    return { status: 'unavailable', reason: 'DASHSCOPE_API_KEY не задан' };
  }

  let model: string | null;
  try {
    model = await resolveSpeechModel(base, apiKey);
  } catch (e) {
    recordAiLegFailure('qwen-tts', errorFailureReason(e));
    return { status: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
  if (!model) {
    recordAiLegFailure('qwen-tts', 'no_model');
    return { status: 'unavailable', reason: 'в каталоге ключа нет модели синтеза речи' };
  }

  const voice = process.env.QWEN_TTS_VOICE?.trim() || DEFAULT_VOICE;
  try {
    const res = await fetch(`${nativeBase(base)}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: { text, voice, language_type: 'Russian' } }),
      signal: AbortSignal.timeout(25_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      recordAiLegFailure('qwen-tts', httpFailureReason(res.status, raw));
      return { status: 'refused', reason: `HTTP ${res.status}: ${raw.slice(0, 300)}` };
    }

    let body: { output?: { audio?: { url?: unknown; data?: unknown } }; usage?: unknown } | null = null;
    try { body = JSON.parse(raw); } catch { /* форма ответа названа ниже */ }
    // Расход — в книги (llm_usage_log); цены синтеза в каталоге нет, строка
    // ляжет с cost NULL — бюджет видит «цена неизвестна», а не ноль.
    if (!(await logSpeechUsage(model, body?.usage))) {
      console.error('[tts] расход не записан: провайдер не отдал usage', model);
    }

    const audio = body?.output?.audio;
    if (typeof audio?.data === 'string' && audio.data) {
      const buf = Buffer.from(audio.data, 'base64');
      if (buf.length < MIN_AUDIO_BYTES) return { status: 'refused', reason: 'аудио короче порога' };
      const bytes = new Uint8Array(buf).buffer;
      return { status: 'ok', audio: bytes, contentType: 'audio/wav', model };
    }
    if (typeof audio?.url !== 'string' || !audio.url) {
      recordAiLegFailure('qwen-tts', 'empty');
      return { status: 'refused', reason: `в ответе нет output.audio: ${raw.slice(0, 200)}` };
    }

    // Ссылка провайдера — http: страница на https её не проиграет (смешанное
    // содержимое), поэтому файл забирает сервер и отдаёт сам.
    const audioRes = await fetch(audio.url, { signal: AbortSignal.timeout(15_000) });
    if (!audioRes.ok) {
      recordAiLegFailure('qwen-tts', httpFailureReason(audioRes.status));
      return { status: 'refused', reason: `файл аудио: HTTP ${audioRes.status}` };
    }
    const bytes = await audioRes.arrayBuffer();
    if (bytes.byteLength < MIN_AUDIO_BYTES) return { status: 'refused', reason: 'аудио короче порога' };
    return { status: 'ok', audio: bytes, contentType: audioRes.headers.get('content-type') || 'audio/wav', model };
  } catch (e) {
    recordAiLegFailure('qwen-tts', errorFailureReason(e));
    return { status: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
}
