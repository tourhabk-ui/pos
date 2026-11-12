// @vitest-environment jsdom
/**
 * Подробный разбор вида на /fish/[id] (12.11, владелец прислал разбор кеты).
 * Сторож — рендер: разделы с заголовками, подзаголовки пунктов, советы
 * нумерованным списком; у вида без разбора — ничего.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FishGuide } from '@/components/fish/FishGuide';
import { FISH_BY_ID, FISH_SPECIES } from '@/lib/fish-species';

afterEach(cleanup);

describe('разбор кеты на странице вида', () => {
  const keta = FISH_BY_ID.keta!;

  it('три раздела с заголовками второго уровня', () => {
    render(<FishGuide species={keta} />);
    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2).toEqual(['О кете', 'Как ловить кету', 'Советы по технике ловли']);
  });

  it('пункты «О кете» и «Как ловить» — подзаголовками с текстом', () => {
    render(<FishGuide species={keta} />);
    const h3 = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(h3).toEqual(['Размеры', 'Окрас', 'Мясо', 'Ареал', 'Питание', 'Нерест', 'Когда', 'Где', 'Спиннинг', 'Нахлыст']);
    expect(screen.getByText(/до 45 тысяч икринок/)).toBeTruthy();
    expect(screen.getByText(/колеблющиеся блёсны 7–12 см/)).toBeTruthy();
  });

  it('советы — нумерованный список из пяти пунктов', () => {
    const { container } = render(<FishGuide species={keta} />);
    const items = container.querySelectorAll('ol > li');
    expect(items).toHaveLength(5);
    expect(items[4]?.textContent).toMatch(/подсак/);
  });

  it('сезон и способы ловли кеты — по разбору', () => {
    expect(keta.seasonMonths).toEqual([7, 8, 9, 10]);
    expect(keta.methods).toEqual(['Спиннинг', 'Нахлыст']);
  });

  it('вид без разбора ничего не рисует', () => {
    const other = FISH_SPECIES.find((f) => !f.guide)!;
    const { container } = render(<FishGuide species={other} />);
    expect(container.innerHTML).toBe('');
  });

  it('в тексте разбора нет эмодзи', () => {
    const text = JSON.stringify(keta.guide);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
