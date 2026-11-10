/**
 * Код раньше модели (02.11, идея из разбора DeepSeek super-agent; владелец:
 * «хорошо Карт-бланш»). Простые реплики Кузьмич решает кодом, без вызова
 * модели: статус заявки по ссылке или ключу, «отмена» без открытой заявки,
 * нажатая кнопка из устаревшего списка, точное название тура. Модель
 * подключается, только если код ничего не решил (`kind: 'none'`).
 *
 * Дату и цену код не называет: статус берётся из базы как есть, тур по
 * названию лишь открывает заявку шагами, где дату спрашивают у человека.
 * Персональных данных ответы не содержат — годятся и для Telegram.
 */
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { REQUEST_KEY_MAX_CHARS, REQUEST_KEY_MIN_CHARS } from '@/lib/mcp/request-status-schema';
import { extractHandoffCode } from '@/lib/requests/handoff';
import { isMyTripAsk } from '@/lib/requests/my-trip-ask';
import { parseTourPick, CONFIRM_YES, isCorrection } from '@/lib/kuzmich/quick-replies';

export type CodeFirst =
  | { kind: 'status'; key: string }
  | { kind: 'handoff'; code: string }
  /** «Моя поездка» (#2970): заявки этого чата, статус и обстановка — lib/requests/my-trip. */
  | { kind: 'my_trip' }
  | { kind: 'cancel_idle' }
  | { kind: 'stale_confirm' }
  | { kind: 'tour'; tourId: number }
  | { kind: 'none' };

const KEY_CHARS = `[A-Za-z0-9_-]{${REQUEST_KEY_MIN_CHARS},${REQUEST_KEY_MAX_CHARS}}`;
const STATUS_LINK = new RegExp(`request-status[^\\s#]*#(${KEY_CHARS})(?![A-Za-z0-9_-])`);
const BARE_KEY = new RegExp(`^(?:статус(?:\\s+заявки)?\\s*:?\\s*)?(${KEY_CHARS})$`, 'i');
const CANCEL_ONLY = /^(?:отмена|отменить|cancel|стоп|stop)[.!]?$/i;

/** Ключ заявки из ссылки на страницу статуса или голым сообщением. */
export function extractRequestKey(text: string): string | null {
  const t = text.trim();
  const link = STATUS_LINK.exec(t);
  if (link) return link[1];
  const bare = BARE_KEY.exec(t);
  // Голый ключ — только со смешанным составом (буквы и цифры): длинное
  // слово без цифр — не ключ, а, например, имя тура латиницей.
  if (bare && /\d/.test(bare[1]) && /[A-Za-z]/.test(bare[1])) return bare[1];
  return null;
}

/** Только разбор текста; базы не трогает. `hasOpenFlow` — есть ли черновик заявки в чате. */
export function classifyCodeFirst(text: string, hasOpenFlow: boolean): CodeFirst {
  const t = text.trim();
  if (!t) return { kind: 'none' };
  const key = extractRequestKey(t);
  if (key) return { kind: 'status', key };
  const code = extractHandoffCode(t);
  if (code) return { kind: 'handoff', code };
  // «Моя поездка» — и посреди черновика заявки: список не трогает её шагов.
  if (isMyTripAsk(t)) return { kind: 'my_trip' };
  if (hasOpenFlow) return { kind: 'none' }; // кнопки и «отмену» внутри заявки ведут её шаги
  if (CANCEL_ONLY.test(t)) return { kind: 'cancel_idle' };
  if (t === CONFIRM_YES || isCorrection(t) && t.length <= 12) return { kind: 'stale_confirm' };
  if (/·/.test(t)) {
    const id = parseTourPick(t);
    if (id) return { kind: 'tour', tourId: id };
  }
  return { kind: 'none' };
}

export const CANCEL_IDLE_REPLY =
  'Открытой заявки в чате нет — отменять нечего. Отправленную заявку отменяет оператор: напишите ему на странице заявки.';
export const STALE_CONFIRM_REPLY =
  'Черновик заявки истёк и не отправлен. Напишите, какой тур интересует, — начнём заново.';

/** Точное название тура витрины (без учёта регистра и «ё»). Сбой базы — null. */
export async function exactTourTitleId(text: string): Promise<number | null> {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length < 4 || t.length > 160) return null;
  // Короткая реплика («Рыбалка») — тема, а не выбор тура: её решает модель.
  const titleOk = t.split(' ').length >= 3;
  const slugOk = /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(t);
  if (!titleOk && !slugOk) return null;
  try {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT ot.id FROM operator_tours ot
        WHERE ${publicTourSql('ot')}
          AND (lower(replace(regexp_replace(ot.title, '\\s+', ' ', 'g'), 'ё', 'е')) = lower(replace($1, 'ё', 'е')) AND $2)
               OR (ot.slug = $1 AND $3)
        LIMIT 2`,
      [t, titleOk, slugOk],
    );
    return rows.length === 1 ? Number(rows[0].id) : null;
  } catch (err) {
    console.warn('[kuzmich-code-first] тур по названию не прочитан', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Статус заявки человеческим текстом: только поля без ПД. */
export function statusReplyText(v: { tour: string | null; accommodation: string | null; date: string | null; human: string; next: string; page: string }): string {
  const what = v.tour ?? v.accommodation;
  return [
    what ? `Заявка: ${what}${v.date ? `, ${v.date}` : ''}.` : 'Заявка найдена.',
    v.human,
    v.next,
    `Страница заявки: ${v.page}`,
  ].filter(Boolean).join('\n');
}

export async function requestStatusReply(key: string, opts: { withHandoff?: boolean } = {}): Promise<string> {
  const { readRequestStatus } = await import('@/lib/mcp/request-status');
  try {
    const text = statusReplyText(await readRequestStatus(key));
    if (opts.withHandoff === false) return text;
    // Ключ предъявлен — владение доказано: одноразовый код для другого канала.
    const { issueHandoffCode, handoffLine } = await import('@/lib/requests/handoff');
    const line = handoffLine(await issueHandoffCode(key));
    return line ? `${text}\n${line}` : text;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'key_not_found') return 'Заявка по этой ссылке не найдена или ссылка истекла (живёт 90 дней). Проверьте, что ссылка скопирована целиком.';
    return 'Статус сейчас не прочитался. Откройте страницу заявки по ссылке или повторите через минуту.';
  }
}
