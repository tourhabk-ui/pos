'use client';

import { useEffect, useState } from 'react';

/**
 * Сколько пикселей сверху занимает плашка, лежащая поверх карты: её нижний
 * край от верха позиционированного родителя плюс зазор. Отдаётся карте как
 * `topInset` — LeafletMap сдвигает верхние углы (кнопки масштаба, подпись
 * OpenStreetMap) ниже плашки.
 *
 * Зачем (ревью 22.10): корень LeafletMap изолирует наложение, и его углы
 * (z-index 1000) больше не всплывают над соседями страницы. На офлайн-/map
 * баннер «Офлайн» и колонка «Скачать» (z-500) закрыли «+», а нижняя полоса
 * фильтров — подпись OpenStreetMap. До изоляции было наоборот: «+» ложился
 * на кнопку GPS в баннере. Пересечение было и тогда — теперь карта знает,
 * что у неё сверху, и обходит это.
 *
 * Меряется ResizeObserver'ом: высота плашки зависит от шрифта и текста.
 * Элемента нет — ноль.
 */
export function useInsetBelow(gap = 6): [(el: HTMLElement | null) => void, number] {
  return useOverlayInset('top', gap);
}

/**
 * Пара к useInsetBelow — от НИЗА: сколько пикселей снизу занимает полоса
 * поверх карты (её верхний край до низа позиционированного родителя плюс
 * зазор). Отдаётся карте как `bottomInset`: плашка «Своё положение не
 * определено» встаёт над полосой фильтров офлайн-/map, а не под ней
 * (ревью 22.10, третий круг).
 *
 * Родитель тоже наблюдается: полоса прижата к его низу, и при смене высоты
 * окна (поворот телефона) её верх уходит вместе с ним. Полоса — прямой
 * ребёнок позиционированного контейнера карты (так у обеих поверхностей
 * /map); наблюдается он, а меряется — от offsetParent.
 */
export function useInsetAbove(gap = 6): [(el: HTMLElement | null) => void, number] {
  return useOverlayInset('bottom', gap);
}

function useOverlayInset(edge: 'top' | 'bottom', gap: number): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      if (edge === 'top') {
        setInset(el.offsetTop + el.offsetHeight + gap);
        return;
      }
      // offsetTop считается от позиционированного родителя — от него и низ.
      // Его нет (элемент скрыт) — мерить не от чего: ноль, а не догадка.
      const parent = el.offsetParent instanceof HTMLElement ? el.offsetParent : null;
      setInset(parent ? Math.max(0, parent.clientHeight - el.offsetTop) + gap : 0);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (edge === 'bottom' && el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [el, gap, edge]);
  return [setEl, el ? inset : 0];
}
