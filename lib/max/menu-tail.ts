/**
 * Меню кабинета только под последним сообщением (31.10, слово владельца «А:
 * меню только снизу»). В MAX нет постоянной клавиатуры, как в Telegram:
 * строка меню ехала под каждым ответом, и чат превращался в столбик
 * одинаковых кнопок. Теперь, когда уходит новое сообщение со строкой меню,
 * у прежнего она снимается — его собственные кнопки («Беру», «Открыть»,
 * «Ответить гостю») остаются.
 *
 * Снять кнопки в MAX можно только правкой сообщения целиком (PUT /messages:
 * пустой массив вложений убирает клавиатуру), а что будет с текстом, если его
 * не прислать, документация не говорит. Поэтому прежний текст присылается тот
 * же, что ушёл: его HTML помнит процесс — последнее сообщение со строкой меню
 * на чат, не дольше суток, в памяти, не в базе и не в логе. Перезапуск память
 * стирает — тогда прежняя строка просто остаётся, как было до 31.10.
 *
 * Строка меню узнаётся по payload: вкладки роли и меню администратора
 * (`rm:<роль>:<действие>`), строка кабинета под экраном (`cb:i`, `cb:t`,
 * `cb:c`, `cb:m`) и строка проката (`rk:`). Ряд, где есть хоть одна другая
 * кнопка, меню не считается и не снимается.
 *
 * Сторож: tests/unit/max-menu-tail.test.ts.
 */

export interface TailButton {
  text: string;
  payload?: string;
  type?: string;
  url?: string;
  intent?: string;
}

interface Tail {
  mid: string;
  html: string;
  rows: TailButton[][];
  at: number;
}

/** Правка сообщения MAX — то, что нужно от клиента. */
export interface TailApi {
  editMessage(mid: string, extra: unknown): Promise<unknown>;
}

const MENU_RE = /^(?:rm:[a-z]{2}:[a-z]{2}|cb:[itcm]|rk:(?:fleet|cal|req|edit|help))$/;
/** Сутки: дольше текст чужого экрана в памяти не держим. */
export const TAIL_TTL_MS = 24 * 3_600_000;
const TAILS = new Map<number, Tail>();

export function isMenuRow(row: readonly TailButton[]): boolean {
  return row.length > 0 && row.every((b) => typeof b.payload === 'string' && MENU_RE.test(b.payload));
}

export function hasMenuRow(rows: readonly (readonly TailButton[])[]): boolean {
  return rows.some((r) => isMenuRow(r));
}

export function withoutMenuRows(rows: readonly TailButton[][]): TailButton[][] {
  return rows.filter((r) => !isMenuRow(r));
}

function prune(nowMs: number): void {
  for (const [chatId, t] of TAILS) if (nowMs - t.at > TAIL_TTL_MS) TAILS.delete(chatId);
}

/**
 * Сообщение `mid` ушло (или правлено) со строкой меню: прежнее последнее
 * сообщение чата теряет строку, это становится последним. Без строки меню —
 * ничего не меняется. Отказ MAX не роняет ответ — он уже ушёл; в лог — без
 * текста.
 */
export async function noteMenuMessage(
  api: TailApi,
  chatId: number,
  mid: string | null | undefined,
  html: string,
  rows: TailButton[][],
  nowMs: number = Date.now(),
): Promise<void> {
  if (!mid || !hasMenuRow(rows)) return;
  prune(nowMs);
  const prev = TAILS.get(chatId);
  TAILS.set(chatId, { mid, html, rows, at: nowMs });
  if (!prev || prev.mid === mid) return;
  const rest = withoutMenuRows(prev.rows);
  try {
    const res = await api.editMessage(prev.mid, {
      text: prev.html,
      format: 'html',
      attachments: rest.length ? [{ type: 'inline_keyboard', payload: { buttons: rest } }] : [],
    }) as { success?: boolean } | null | undefined;
    if (res?.success === false) console.error('[max/menu-tail] строка меню с прежнего сообщения не снята: MAX не принял правку');
  } catch (err) {
    console.error(`[max/menu-tail] строка меню с прежнего сообщения не снята: ${err instanceof Error ? err.name : 'отказ'}`);
  }
}

/** mid из ответа MAX на отправку: `{ body: { mid } }`; нет — null. */
export function sentMid(res: unknown): string | null {
  const mid = (res as { body?: { mid?: unknown } } | null | undefined)?.body?.mid;
  return typeof mid === 'string' && mid !== '' ? mid : null;
}

/** Для тестов: забыть всё. */
export function resetMenuTails(): void {
  TAILS.clear();
}
