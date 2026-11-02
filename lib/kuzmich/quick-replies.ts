/**
 * Кнопки шагов заявки Кузьмича (02.11, владелец: «минимум шагов, кнопки
 * вместо набора, одинаково в MAX и Telegram»). Кнопка — быстрый ответ:
 * нажатие отправляет её текст обычным сообщением, поэтому шаги заявки
 * читают его тем же разбором, что и набранный текст. Своих колбэков и
 * состояния у кнопок нет — одно поведение в обоих мессенджерах.
 */
export type QuickReplies = string[][];

const TITLE_MAX = 30;

/** Подпись кнопки тура: номер первым — по нему шаг «тур» и узнаёт выбор. */
export function tourPickLabel(id: number, title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  return `${id} · ${t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t}`;
}

/** Номер тура из ответа: «61», «ID61» или нажатая кнопка «61 · Название». */
export function parseTourPick(text: string): number | null {
  const m = /^(?:id\s*)?(\d{1,7})(?:\s*·.*)?$/is.exec(text.trim());
  return m ? Number(m[1]) : null;
}

/** До шести туров — по кнопке в ряд. */
export function tourPickButtons(tours: readonly { id: number; title: string }[]): QuickReplies {
  const seen = new Set<number>();
  const rows: QuickReplies = [];
  for (const t of tours) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    rows.push([tourPickLabel(t.id, t.title)]);
    if (rows.length >= 6) break;
  }
  rows.push(['Отмена']);
  return rows;
}

export const GUEST_BUTTONS: QuickReplies = [['1', '2', '3'], ['4', '5', '6'], ['Отмена']];

export const CONFIRM_YES = 'Да, отправить';
export const CONFIRM_FIX = 'Исправить';
export const CONFIRM_BUTTONS: QuickReplies = [[CONFIRM_YES], [CONFIRM_FIX, 'Отмена']];

export const CANCEL_BUTTONS: QuickReplies = [['Отмена']];

/** «Исправить» на шаге проверки: данные заново, тур остаётся. */
export function isCorrection(text: string): boolean {
  return /^(исправ|поправ|изменить|не так)/i.test(text.trim());
}
