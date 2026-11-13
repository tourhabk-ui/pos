/**
 * Слова клиента не по-русски — адресату заявки с переводом (слово владельца
 * 13.11: «когда иностранцы обращаются к оператору, то нужно для оператора
 * переводить на русский»).
 *
 * Заявку из Китая приносит ИИ-агент, и комментарий в ней по-китайски.
 * Оператор читает по-русски: без перевода «Комментарий: 我们想…» для него —
 * пустое место, и заявка остаётся без ответа.
 *
 * ── Что делает ────────────────────────────────────────────────────────────
 *
 * Берёт свободный текст заявки по частям (комментарий, направление,
 * пожелания) и отдаёт строки для сообщения адресату — по строке на часть не
 * по-русски. Русскую часть не трогает и модель на неё не зовёт. Правило
 * перевода одно — lib/ai/translate-text (текст — данные, а не поручение;
 * в модель после redactPII; ответ сверяется).
 *
 * ── Чего не делает ────────────────────────────────────────────────────────
 *
 *  · исходник не заменяет: перевод стоит РЯДОМ со словами клиента и назван
 *    машинным. По переводу читают, по исходнику проверяют;
 *  · не молчит об отказе: часть не по-русски, а перевод не получен — так и
 *    сказано адресату (§4.0). В лог — род причины, без текста клиента;
 *  · не держит заявку: перевод ждут не дольше NOTICE_TRANSLATE_TIMEOUT_MS,
 *    заявка уходит адресату и без него;
 *  · строки идут только туда, куда идут сами слова клиента — в сообщение с
 *    ПД (MAX). В заглушку Telegram слова клиента не уходят, и перевод тоже.
 *
 * Сторож: tests/unit/foreign-text.test.ts.
 */

import { needsRussian } from '@/lib/ai/russian-text';
import type { TranslationOutcome } from '@/lib/ai/translate-text';
import { logText } from '@/lib/log/log-text';

export interface ForeignPart {
  /** Что это за часть — словом в именительном падеже: «комментарий», «направление». */
  what: string;
  text: string | null | undefined;
}

/** Сколько знаков части уходит на перевод: сообщение адресату — не документ. */
export const NOTICE_TRANSLATE_SOURCE_MAX = 600;
/** Сколько ждём перевод, прежде чем отправить заявку без него. */
export const NOTICE_TRANSLATE_TIMEOUT_MS = 8000;

type Translate = (text: string) => Promise<TranslationOutcome>;

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

async function withTimeout(run: Promise<TranslationOutcome>, ms: number): Promise<TranslationOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<TranslationOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'failed', reason: `перевод не уложился в ${Math.round(ms / 1000)} с` }), ms);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Переводчик не загрузился — это «не смог», а не падение заявки. */
async function loadTranslator(): Promise<Translate> {
  try {
    return (await import('@/lib/ai/translate-text')).translateToRussian;
  } catch (err) {
    const why = `переводчик не загрузился: ${err instanceof Error ? err.message : String(err)}`;
    return async () => ({ status: 'failed', reason: why });
  }
}

/**
 * Строки перевода для сообщения адресату. Пустой список — переводить нечего:
 * все части по-русски или пусты. Строки — простой текст: экранирует тот, кто
 * собирает сообщение. Не бросает.
 */
export async function clientTranslationLines(
  parts: readonly ForeignPart[],
  where: string,
  opts: { translate?: Translate; timeoutMs?: number } = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? NOTICE_TRANSLATE_TIMEOUT_MS;
  const foreign = parts
    .map((p) => ({ what: p.what, text: (p.text ?? '').trim() }))
    .filter((p) => needsRussian(p.text));
  if (foreign.length === 0) return [];
  // Переводчик грузится только здесь: заявка по-русски (их большинство) не
  // тянет за собой провайдеров ИИ в модули уведомлений.
  const translate = opts.translate ?? (await loadTranslator());

  return Promise.all(foreign.map(async (p) => {
    const cut = p.text.length > NOTICE_TRANSLATE_SOURCE_MAX;
    const source = cut ? p.text.slice(0, NOTICE_TRANSLATE_SOURCE_MAX) : p.text;
    let out: TranslationOutcome;
    try {
      out = await withTimeout(translate(source), timeoutMs);
    } catch (err) {
      out = { status: 'failed', reason: `перевод упал: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (out.status === 'translated') {
      return `Перевод (машинный), ${p.what}: ${out.text}${cut ? ' … (переведено начало текста)' : ''}`;
    }
    // «Переводить нечего» здесь быть не может: часть отобрана как не русская.
    const reason = out.status === 'failed' ? out.reason : 'переводчик счёл текст русским';
    // В лог — род причины, без хвоста после двоеточия: в хвосте бывает обрывок
    // ответа модели, то есть слова клиента в переводе.
    console.error(`[foreign-text] ${logText(where, 80)}: ${p.what} не по-русски, перевод не получен — ${logText(reason.split(':')[0], 80)}`);
    return `${cap(p.what)} не по-русски; машинный перевод не получен.`;
  }));
}
