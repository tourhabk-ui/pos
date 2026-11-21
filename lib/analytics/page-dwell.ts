/**
 * Просмотры с записанным временем — отдельный счёт рядом с общим (21.11,
 * слово владельца «делай»).
 *
 * Перепись уходов 21.11 (prod-check 205): на /planning 372 просмотра за 30
 * дней, из них у 358 видимое время не записано, 365 — прямой вход без
 * источника, 357 — с компьютера, 257 — за три дня волной. На
 * /tools/equipment — 74 из 75 без времени. Так ходит автоматический браузер:
 * скрипт страницы исполнил (маяк есть), вкладку закрыл, не дав браузеру
 * дослать время. Фильтр ботов по семейству браузера его не ловит, и доля
 * ухода «98%» описывала его, а не людей.
 *
 * Время браузер досылает сам — при переходе по сайту, при скрытии вкладки и
 * при уходе со страницы (components/shared/PageViewTracker.tsx). Записанное
 * время — признак живого браузера, а не доказательство человека: телефон,
 * выгрузивший вкладку из памяти, время тоже не дошлёт. Поэтому это отдельный
 * счёт рядом с общим, а не новый фильтр, выбрасывающий строки.
 *
 * Фрагмент ждёт в источнике колонок dwell_ms, session_id и next_id (следующий
 * просмотр того же визита) — как запросы поведения в
 * app/api/admin/analytics/traffic/route.ts. Уход считается тем же правилом,
 * что общий: визит закончился на этой странице.
 */
export const PAGE_DWELL_COLUMNS = `
  COUNT(*) FILTER (WHERE dwell_ms IS NOT NULL) AS with_dwell,
  COUNT(*) FILTER (WHERE dwell_ms IS NOT NULL AND session_id IS NOT NULL AND next_id IS NULL) AS with_dwell_exits`;

export interface PageDwellCounts {
  /** Просмотры, для которых браузер дослал видимое время. */
  withDwell: number;
  /** Из них — последний просмотр визита. */
  withDwellExits: number;
}

export function pageDwellCounts(row: { with_dwell: string | number | null; with_dwell_exits: string | number | null }): PageDwellCounts {
  return {
    withDwell: Number(row.with_dwell ?? 0),
    withDwellExits: Number(row.with_dwell_exits ?? 0),
  };
}

/**
 * Доля ухода среди просмотров со временем. null — таких просмотров нет:
 * «0%» сказало бы, что все остались, а сказать нечего (§4.0).
 */
export function dwellExitShare(c: PageDwellCounts): number | null {
  if (c.withDwell <= 0) return null;
  return Math.round((c.withDwellExits / c.withDwell) * 100);
}
