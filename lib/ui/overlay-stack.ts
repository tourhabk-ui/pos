/**
 * Стопка слоёв поверх экрана: окна, шторки, карточки на карте (владелец
 * 10.11: «ux у нас страдает», разбор meta/astryx).
 *
 * До этой правки у нас было 17 окон с role="dialog" и у каждого — своё
 * закрытие или никакого: 12 не закрывались по Escape, фокус не уходил внутрь
 * и не возвращался на кнопку, открывшую окно. Человек с клавиатурой или
 * экранным диктором оставался за окном, а Escape во вложенном окне (снимок
 * поверх карточки) закрывал оба.
 *
 * Правило — контракт «overlay dismissal» из meta/astryx
 * (docs/families/overlay-dismissal.md, MIT):
 *  - каждый слой, который закрывается по Escape, встаёт в одну стопку (FR1);
 *  - одно нажатие закрывает один слой — верхний; до нижних оно не доходит (FR2);
 *  - содержимое вправе забрать Escape первым: обработанное событие
 *    (`defaultPrevented`) стопка не трогает (FR5);
 *  - Escape во время набора иероглифа отменяет набор, а не закрывает слой (FR6);
 *  - фокус возвращается туда, откуда открыли, если он потерялся (FR9).
 *
 * Здесь — стопка и единственный слушатель документа; хук — hooks/use-overlay.
 */
import { isImeKeyEvent } from '@/lib/ui/ime';

export interface OverlayEntry {
  /** Закрыть слой. Стопка зовёт его, когда слой верхний. */
  onEscape: () => void;
}

const stack: OverlayEntry[] = [];
let listening = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' && e.key !== 'Esc') return;
  if (e.defaultPrevented || isImeKeyEvent(e)) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.onEscape();
}

/** Встать в стопку; вернёт снятие. Порядок вставки — порядок открытия. */
export function pushOverlay(entry: OverlayEntry): () => void {
  stack.push(entry);
  // Слушатель — на window: нажатие всплывает до него от любого элемента, а
  // содержимое, забравшее Escape (preventDefault), успевает раньше.
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    listening = true;
  }
  return () => {
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0 && listening) {
      window.removeEventListener('keydown', onKeyDown);
      listening = false;
    }
  };
}

/** Верхний слой: только он держит Tab (вложенное окно — свой круг). */
export function overlayTop(): OverlayEntry | undefined {
  return stack[stack.length - 1];
}

/** Сколько слоёв открыто — для тестов и отладки. */
export function overlayDepth(): number {
  return stack.length;
}

/**
 * Что ловит Tab. Список — FOCUSABLE_SELECTOR из meta/astryx
 * (packages/core/src/hooks/focusableSelector.ts, MIT): кроме кнопок и полей
 * в нём contenteditable, медиа с управлением и summary — иначе Tab уходил из
 * окна, где единственный интерактив — такое поле.
 */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled]), [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], iframe, details > summary:first-child';

/** Видимые фокусируемые элементы слоя, в порядке документа. */
export function focusablesIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');
}
