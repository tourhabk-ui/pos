/**
 * lib/notifications/exolve.ts — SMS и голосовой звонок через МТС Exolve.
 *
 * Канал для тех, кого MAX не разбудит: дежурный ночью, турист без
 * интернета. Сверено с документацией 01.10 (docs.exolve.ru):
 *   SMS   — POST https://api.exolve.ru/messaging/v1/SendSMS
 *           {number, destination, text} → {message_id}
 *   Звонок — POST https://api.exolve.ru/call/v1/MakeVoiceMessage
 *           {source, destination, tts:{text, voice, lang}} → {call_id}
 *   Авторизация — `Authorization: Bearer <ключ приложения>`.
 *
 * Включается двумя переменными Timeweb: `EXOLVE_API_KEY` и `EXOLVE_NUMBER`
 * (номер в формате 79XXXXXXXXX). Нет хотя бы одной — исход `not_configured`,
 * а не «отправлено» и не «сбой»: незаданный канал и упавший канал —
 * разные состояния, и вызывающий решает, что с ними делать (CLAUDE.md §4.0).
 *
 * Чего здесь нет намеренно:
 * - SMS с номера 8-800 и городского Exolve не отправляет вовсе (документация,
 *   «Метод SendSMS», примечание) — `EXOLVE_NUMBER` обязан быть мобильным;
 * - в пробном периоде текст SMS подменяется, а звонить можно только на свой
 *   подтверждённый номер — проверка боем возможна только после договора;
 * - ключ не печатается нигде, ни целиком, ни хвостом.
 */
import { logText } from '@/lib/log/log-text';

const SMS_URL = 'https://api.exolve.ru/messaging/v1/SendSMS';
const CALL_URL = 'https://api.exolve.ru/call/v1/MakeVoiceMessage';
const TIMEOUT_MS = 10_000;
/** Предел синтеза речи у Exolve — 1000 символов (документация MakeVoiceMessage). */
export const TTS_MAX = 1000;

export type ExolveResult =
  | { status: 'sent'; id: string }
  | { status: 'failed'; reason: string }
  | { status: 'not_configured'; reason: string };

interface ExolveConfig { key: string; number: string }

function config(): ExolveConfig | null {
  const key = process.env.EXOLVE_API_KEY?.trim();
  const number = normalizeRuPhone(process.env.EXOLVE_NUMBER ?? '');
  if (!key || !number) return null;
  return { key, number };
}

/** Настроен ли канал: оба значения заданы и номер читается. */
export function exolveConfigured(): boolean {
  return config() !== null;
}

/**
 * Российский номер в форму, которую ждёт Exolve: 7 и десять цифр.
 * «+7 914 123-45-67», «8 (914) 1234567», «79141234567» → «79141234567».
 * Всё прочее — null: угадывать номер, на который уйдёт тревога, нельзя.
 */
export function normalizeRuPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `7${digits.slice(1)}`;
  if (digits.length === 10 && digits[0] === '9') return `7${digits}`;
  return null;
}

function notConfigured(): ExolveResult {
  return { status: 'not_configured', reason: 'EXOLVE_API_KEY или EXOLVE_NUMBER не заданы' };
}

async function post(url: string, key: string, body: unknown, idField: 'message_id' | 'call_id', what: string): Promise<ExolveResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = `${what}: сеть — ${err instanceof Error ? err.message : String(err)}`;
    console.error('[exolve]', logText(reason, 200));
    return { status: 'failed', reason };
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    // Тело ошибки у Exolve — короткая фраза («destination is not permitted
    // for delivery», «malformed token»); ключа в нём нет.
    const reason = `${what}: HTTP ${res.status} ${logText(raw, 160)}`;
    console.error('[exolve]', reason);
    return { status: 'failed', reason };
  }
  let id: unknown;
  try { id = (JSON.parse(raw) as Record<string, unknown>)[idField]; } catch { id = undefined; }
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id) === '') {
    // 200 без идентификатора — не «отправлено»: проверить доставку нечем.
    const reason = `${what}: ответ без ${idField}`;
    console.error('[exolve]', reason, logText(raw, 160));
    return { status: 'failed', reason };
  }
  return { status: 'sent', id: String(id) };
}

/** SMS на российский номер. Текст — как есть; длинный Exolve режет на сегменты (до 10). */
export async function sendExolveSms(destination: string, text: string): Promise<ExolveResult> {
  const cfg = config();
  if (!cfg) return notConfigured();
  const to = normalizeRuPhone(destination);
  if (!to) return { status: 'failed', reason: 'SMS: номер получателя не российский мобильный' };
  if (!text.trim()) return { status: 'failed', reason: 'SMS: пустой текст' };
  return post(SMS_URL, cfg.key, { number: cfg.number, destination: to, text }, 'message_id', 'SMS');
}

/**
 * Голосовой звонок с синтезом речи: робот звонит и читает текст.
 * Голос 1 (Алёна), язык 1 (русский), скорость чуть ниже обычной — текст
 * слушают спросонья. Длиннее 1000 символов Exolve не синтезирует — отказ
 * здесь, а не обрезка: обрезанная тревога теряет хвост, где обычно номер дела.
 */
export async function makeExolveVoiceCall(destination: string, text: string): Promise<ExolveResult> {
  const cfg = config();
  if (!cfg) return notConfigured();
  const to = normalizeRuPhone(destination);
  if (!to) return { status: 'failed', reason: 'Звонок: номер получателя не российский' };
  const t = text.trim();
  if (!t) return { status: 'failed', reason: 'Звонок: пустой текст' };
  if (t.length > TTS_MAX) return { status: 'failed', reason: `Звонок: текст длиннее ${TTS_MAX} символов` };
  return post(CALL_URL, cfg.key, {
    source: cfg.number,
    destination: to,
    tts: { text: t, voice: 1, lang: 1, speed: 0.9 },
  }, 'call_id', 'Звонок');
}
