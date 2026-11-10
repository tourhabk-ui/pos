/**
 * Набор иероглифа (IME) — не команда (владелец 10.11: «ux у нас страдает»,
 * разбор meta/astryx).
 *
 * Китайский, японский и корейский набираются через IME: человек пишет
 * латиницей, а клавишей Enter выбирает иероглиф из подсказки. Браузер шлёт
 * этот Enter обычным keydown ДО `compositionend`, и обработчик «Enter —
 * отправить» отправлял недописанное. 10.11 так было в 23 полях, включая чат
 * Кузьмича, виджет партнёра, планер, чат спасателя и поиск, — при том что у
 * платформы есть китайские страницы (/zh).
 *
 * Правило: обработчик, который по Enter (а в окнах — по Escape) выполняет
 * команду, первым делом спрашивает `isImeKeyEvent(e.nativeEvent)` и при
 * `true` молчит. Сторож — tests/unit/ime-enter-guard.test.tsx.
 *
 * Оба признака нужны: `isComposing` — стандартный; keyCode 229 — запасной:
 * часть IME и старый Safari шлют такой keydown, когда `isComposing` ещё не
 * `true`. Параметр типизирован по форме — подходит и `e.nativeEvent` из
 * React, и событие DOM.
 *
 * Взято из meta/astryx (packages/core/src/utils/ime.ts):
 * Copyright (c) Meta Platforms, Inc. and affiliates. MIT License.
 */

/** keyCode, который браузер ставит событию, пока его обрабатывает IME. */
const IME_PROCESSING_KEY_CODE = 229;

export function isImeKeyEvent(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === IME_PROCESSING_KEY_CODE;
}
