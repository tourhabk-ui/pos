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
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!el) return;
    const measure = () => setInset(el.offsetTop + el.offsetHeight + gap);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, gap]);
  return [setEl, el ? inset : 0];
}
