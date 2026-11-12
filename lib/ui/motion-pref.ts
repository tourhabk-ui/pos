/**
 * Движение интерфейса и настройка «уменьшить движение» (12.11, набор анимаций
 * из каталога Motion по выбору владельца: «Все пять»).
 *
 * Анимация здесь — подтверждение, а не задержка. Поэтому пауза «галочки» на
 * кнопке заявки короткая и пропускается совсем, когда человек попросил
 * систему не двигать интерфейс или когда это узнать нечем: украшение не
 * должно задерживать ответ тому, кому оно не нужно.
 */

/** Сколько кнопка показывает галочку перед экраном «заявка принята». */
export const DONE_BEAT_MS = 650;

/**
 * true — человек просил уменьшить движение. Без `matchMedia` (сервер, старый
 * браузер) ответ неизвестен; вызывающий трактует это как «паузы не нужно».
 */
export function prefersReducedMotion(): boolean | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Пауза на галочку: только когда движение разрешено явно. */
export function doneBeatMs(): number {
  return prefersReducedMotion() === false ? DONE_BEAT_MS : 0;
}

export function waitDoneBeat(): Promise<void> {
  const ms = doneBeatMs();
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
