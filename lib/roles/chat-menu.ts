/**
 * Общая строка кнопок под ответом кабинета. Роль и набор кнопок задаёт
 * вызывающий: здесь только «приклеить один раз» и разметка Telegram.
 *
 * Прокат остаётся на своих payload `rk:` (lib/rental/cabinet-bar). Чужой
 * роли эти кнопки не подменяются.
 */

export interface MenuButton {
  text: string;
  payload: string;
  intent?: 'positive' | 'negative';
}

/** Последняя строка уже эта — вторую не клеим. */
export function appendMenu<T extends { payload: string }>(rows: T[][], bar: T[]): T[][] {
  const last = rows[rows.length - 1];
  if (last && last.length === bar.length && last.every((b, i) => b.payload === bar[i]?.payload)) return rows;
  return [...rows, bar];
}

export function menuMarkup(menu: MenuButton[], content: MenuButton[][] = []): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: appendMenu(content, menu).map((row) => row.map((b) => ({
      text: b.text,
      callback_data: b.payload,
    }))),
  };
}
