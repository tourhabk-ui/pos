/**
 * Прод 24.10: ответ «Однодневные: … Вертолётные: … Многодневные: …»
 * рисовался абзацами, в чате не было ни одного пункта списка.
 * Промпт просит маркеры, чат узнаёт и маркеры, и строки «Заголовок: …».
 *
 * Проверка качества 24.10: годы и номера в начале строки не теряются. Список
 * извержений «1975. …» рисовался пунктами с точкой без годов, шаги
 * «1. Позвоните 112» — без номеров: число срезалось, нумерованного списка не было.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import ChatText from '@/components/kuzmich/ChatText';
import { cleanAIResponse, KUZMICH_SYSTEM } from '@/lib/kuzmich/core';

afterEach(() => cleanup());

describe('список в ответе Кузьмича', () => {
  it('группы с двоеточием рисуются пунктами', () => {
    const { container } = render(
      <ChatText text={'Однодневные: сплав по Быстрой.\nВертолётные: Курильское озеро.\nМногодневные: Налычево.'} />,
    );
    const items = [...container.querySelectorAll('li')].map((li) => li.textContent);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(items).toEqual([
      'Однодневные: сплав по Быстрой.',
      'Вертолётные: Курильское озеро.',
      'Многодневные: Налычево.',
    ]);
  });

  it('маркеры тоже рисуются пунктами, а предложение остаётся абзацем', () => {
    const { container } = render(
      <ChatText text={'Сезон короткий.\n- берег\n- сопка'} />,
    );
    expect(container.querySelector('p')?.textContent).toBe('Сезон короткий.');
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['берег', 'сопка']);
  });

  it('промпт просит список, а очистка ответа не срезает маркеры', () => {
    expect(KUZMICH_SYSTEM).toMatch(/ПЕРЕЧИСЛЕНИЕ — СПИСКОМ/);
    expect(KUZMICH_SYSTEM).toMatch(/- Однодневные: …/);
    expect(KUZMICH_SYSTEM).not.toMatch(/НИКАКИХ СПИСКОВ/);
    expect(cleanAIResponse('- Однодневные: сплав\n1. Вертолётные: озеро\n**жирное**')).toBe(
      '- Однодневные: сплав\n1. Вертолётные: озеро\nжирное',
    );
  });
});

describe('ChatText: числа в начале строки', () => {
  it('год в начале строки остаётся в тексте, строки — абзацы, а не пункты', () => {
    const { container } = render(
      <ChatText text={'1975. Большое трещинное Толбачинское извержение.\n2012. Новое извержение Толбачика.'} />,
    );
    expect(container.textContent).toContain('1975. Большое трещинное Толбачинское извержение.');
    expect(container.textContent).toContain('2012. Новое извержение Толбачика.');
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('нумерованные шаги — нумерованный список с номерами ответа', () => {
    const { container } = render(<ChatText text={'Если потерялись:\n1. Позвоните 112.\n2. Оставайтесь на месте.\n4. Берегите заряд.'} />);
    const list = container.querySelector('ol');
    expect(list).not.toBeNull();
    const items = Array.from(list?.querySelectorAll('li') ?? []);
    expect(items.map((li) => [li.value, li.textContent])).toEqual([
      [1, 'Позвоните 112.'],
      [2, 'Оставайтесь на месте.'],
      [4, 'Берегите заряд.'],
    ]);
    expect(container.querySelector('ul')).toBeNull();
    expect(container.textContent).toContain('Если потерялись:');
  });

  it('пункты с дефисом — по-прежнему список с точкой; смена рода закрывает список', () => {
    const { container } = render(<ChatText text={'- берег\n- сопка\n1. первый шаг\n2. второй шаг'} />);
    expect(Array.from(container.querySelectorAll('ul li')).map((li) => li.textContent)).toEqual(['берег', 'сопка']);
    expect(Array.from(container.querySelectorAll('ol li')).map((li) => li.textContent)).toEqual(['первый шаг', 'второй шаг']);
  });
});
