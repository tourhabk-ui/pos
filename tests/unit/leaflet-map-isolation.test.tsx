/**
 * Сторож: слои Leaflet не выходят за пределы карты (22.10).
 *
 * Тайлы и маркеры Leaflet стоят на z-index 400 и 1000, углы контролов — на
 * 1000. Корень LeafletMap не создавал своего контекста наложения, и эти
 * числа спорили со всей страницей. Замер на проде 22.10:
 *   — плашка «N маршрутов» и карточка маршрута планировщика (с кнопками
 *     «Заменить» / «Добавить в план») были в DOM, но рисовались ПОД тайлами:
 *     нажатие на точку выглядело так, будто ничего не произошло;
 *   — баннер согласия и модалки резались картой;
 *   — на странице маршрута при прокрутке тайлы и «+/−» ложились поверх
 *     шапки сайта вместе с кнопкой SOS.
 *
 * Рендером: корень карты изолирует наложение.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import LeafletMap from '@/components/shared/LeafletMap';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('LeafletMap держит свои слои при себе', () => {
  it('корень карты — свой контекст наложения (isolation: isolate)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<LeafletMap markers={[]} height="300px" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.isolation).toBe('isolate');
    expect(root.style.position).toBe('relative');
    expect(root.style.height).toBe('300px');
  });
});
