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

/**
 * Больше трёх кнопок в ряду MAX не помещает: ширина делится поровну, и
 * подпись режется («Входящ…» на снимке владельца 31.10, строка из четырёх).
 */
export const MENU_ROW_MAX = 3;

/** Ряды строки меню: не больше трёх кнопок, ряды поровну (4 — 2+2, 5 — 3+2, 6 — 3+3). */
export function menuRows<T>(bar: T[]): T[][] {
  if (bar.length === 0) return [];
  const count = Math.ceil(bar.length / MENU_ROW_MAX);
  const base = Math.floor(bar.length / count);
  let extra = bar.length % count;
  const out: T[][] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    out.push(bar.slice(at, at + size));
    at += size;
  }
  return out;
}

function sameRow<T extends { payload: string }>(a: T[] | undefined, b: T[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x.payload === b[i]?.payload);
}

/** Хвост уже эта строка меню — вторую не клеим. */
export function appendMenu<T extends { payload: string }>(rows: T[][], bar: T[]): T[][] {
  const tail = menuRows(bar);
  if (tail.length === 0) return rows;
  const from = rows.length - tail.length;
  if (from >= 0 && tail.every((row, i) => sameRow(rows[from + i], row))) return rows;
  return [...rows, ...tail];
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
