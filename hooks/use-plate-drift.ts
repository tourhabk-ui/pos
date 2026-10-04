'use client';

/**
 * Лента туров на главной медленно плывёт справа налево (решение владельца
 * 04.10: «пусть блок туров на главной медленно плывёт справа налево»).
 *
 * Это пересматривает аудит 24.09 (#42), снявший автопрокрутку: тогда
 * карточка ПРЫГАЛА каждые 5 с из-под пальца, пока человек читал цену, и
 * остановить её было нечем (WCAG 2.2.2). Решение владельца выполнено так,
 * чтобы та причина не вернулась:
 *
 *  - не прыжки, а непрерывный дрейф: DRIFT_PX_PER_SEC, карточка проходит
 *    экран за десяток секунд — прочитать цену успеваешь;
 *  - палец, колесо, фокус клавиатуры, наведение мыши — лента стоит, и ещё
 *    RESUME_AFTER_MS после того, как её отпустили;
 *  - кнопка «Остановить ленту» рядом с точками — пауза, пока её не снимут
 *    (2.2.2 требует именно механизма остановки, а не только паузы под пальцем);
 *  - `prefers-reduced-motion: reduce` — дрейфа нет вовсе;
 *  - вкладка в фоне — кадры не считаются.
 *
 * Петля бесшовная: лента рендерится дважды (вторая копия aria-hidden и
 * inert), и когда позиция уходит за ширину первой копии, из неё вычитается
 * эта ширина — глаз видит те же карточки на тех же местах.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

export const DRIFT_PX_PER_SEC = 24;
export const RESUME_AFTER_MS = 4000;

/** Позиция внутри петли: [0, loopWidth). loopWidth ≤ 0 — петли нет, позиция как есть. */
export function wrapDrift(pos: number, loopWidth: number): number {
  if (!(loopWidth > 0)) return pos;
  const r = pos % loopWidth;
  return r < 0 ? r + loopWidth : r;
}

/** Ширина первой копии: от первой карточки до первой карточки второй копии. */
function loopWidthOf(c: HTMLElement, count: number): number {
  const a = c.children[0] as HTMLElement | undefined;
  const b = c.children[count] as HTMLElement | undefined;
  return a && b ? b.offsetLeft - a.offsetLeft : 0;
}

export function usePlateDrift(ref: RefObject<HTMLElement | null>, count: number) {
  // Включается только на клиенте и только без reduced-motion: сервер
  // рендерит одну копию, гидратация не расходится.
  const [enabled, setEnabled] = useState(false);
  const [stopped, setStopped] = useState(false);
  const holdUntil = useRef(0);
  const hovered = useRef(false);

  useEffect(() => {
    if (count < 2) return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setEnabled(!mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [count]);

  useEffect(() => {
    const c = ref.current;
    if (!enabled || stopped || !c) return;
    // Snap «mandatory» возвращал бы каждый сдвиг на долю пикселя назад.
    const prevSnap = c.style.scrollSnapType;
    c.style.scrollSnapType = 'none';
    let pos = c.scrollLeft;
    let last = performance.now();
    let raf = 0;

    const hold = () => { holdUntil.current = performance.now() + RESUME_AFTER_MS; };
    const onEnter = () => { hovered.current = true; };
    const onLeave = () => { hovered.current = false; hold(); };

    const step = (t: number) => {
      const dt = Math.min(t - last, 100);
      last = t;
      if (hovered.current || t < holdUntil.current || document.hidden) {
        // Человек листает сам — дрейф продолжит с того места, где он оставил.
        pos = c.scrollLeft;
      } else {
        pos = wrapDrift(pos + (DRIFT_PX_PER_SEC * dt) / 1000, loopWidthOf(c, count));
        c.scrollLeft = pos;
      }
      raf = requestAnimationFrame(step);
    };

    const opts = { passive: true } as const;
    c.addEventListener('pointerdown', hold, opts);
    c.addEventListener('touchstart', hold, opts);
    c.addEventListener('touchmove', hold, opts);
    c.addEventListener('wheel', hold, opts);
    c.addEventListener('focusin', hold);
    c.addEventListener('mouseenter', onEnter);
    c.addEventListener('mouseleave', onLeave);
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      c.style.scrollSnapType = prevSnap;
      c.removeEventListener('pointerdown', hold);
      c.removeEventListener('touchstart', hold);
      c.removeEventListener('touchmove', hold);
      c.removeEventListener('wheel', hold);
      c.removeEventListener('focusin', hold);
      c.removeEventListener('mouseenter', onEnter);
      c.removeEventListener('mouseleave', onLeave);
    };
  }, [enabled, stopped, count, ref]);

  /** Нажатие на точку — человек выбрал карточку, лента ждёт. */
  const holdNow = () => { holdUntil.current = performance.now() + RESUME_AFTER_MS; };

  return {
    /** Рендерить вторую копию ленты (петля). */
    looping: enabled,
    /** Дрейф идёт (для кнопки). */
    drifting: enabled && !stopped,
    toggle: () => setStopped(s => !s),
    holdNow,
  };
}
