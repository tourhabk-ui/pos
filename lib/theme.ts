/**
 * Тема платформы: ОДИН источник значения по умолчанию.
 *
 * До 24.09 умолчаний было два, и они спорили. Скрипт против вспышки в
 * app/layout.tsx красил первый кадр светлым (редизайн 31.07), а
 * ThemeProvider после гидрации ставил `saved ?? 'dark'` и тут же записывал
 * 'dark' в localStorage. Новый посетитель видел кремовую страницу, через
 * 3–5 секунд она перекрашивалась в тёмную, а на главной менялось и фото
 * героя (hero-light → hero-dark). Тёмная тема при этом записывалась
 * навсегда: человек её не выбирал, но жил в ней дальше (аудит П1, #6/#103).
 *
 * Решение владельца 24.09: по умолчанию — светлая. Скрипт и провайдер
 * читают значение отсюда; провайдер вдобавок берёт стартовое значение из
 * `data-theme`, который уже выставил скрипт, а не выводит своё.
 *
 * `kh-theme` пишется только когда человек сам нажал переключатель: запись
 * без выбора — это выдуманное предпочтение (§4.0).
 *
 * Сторож: tests/unit/theme-single-default.test.tsx.
 */

export type Theme = 'light' | 'dark';

export const DEFAULT_THEME: Theme = 'light';

/**
 * Ключ ЯВНОГО выбора человека. Прежний `kh-theme` старый провайдер писал
 * каждому посетителю ('dark') без его нажатия — такая запись не выбор, и
 * читать её значит навсегда оставить людей в теме, которую они не выбирали
 * (решение владельца 24.09 до них бы не дошло). Поэтому ключ новый: старый
 * игнорируется, выбор, сделанный после 24.09, помнится.
 */
export const THEME_STORAGE_KEY = 'kh-theme-choice';

/**
 * Текст инлайн-скрипта против вспышки. Строится из тех же констант, что
 * читает провайдер, — разойтись им негде.
 */
export function themeBootScript(): string {
  const d = JSON.stringify(DEFAULT_THEME);
  const k = JSON.stringify(THEME_STORAGE_KEY);
  return (
    `(function(){var r=document.documentElement;try{var t=localStorage.getItem(${k});` +
    `if(t!=='light'&&t!=='dark')t=${d};r.setAttribute('data-theme',t);` +
    `r.classList.toggle('dark',t==='dark');}catch(e){r.setAttribute('data-theme',${d});` +
    `r.classList.toggle('dark',${d}==='dark');}})();`
  );
}

/** Тема, которую уже покрасил скрипт; без DOM — значение по умолчанию. */
export function readDomTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : DEFAULT_THEME;
}
