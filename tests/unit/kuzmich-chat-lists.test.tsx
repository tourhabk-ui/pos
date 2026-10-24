/**
 * Прод 24.10: ответ «Однодневные: … Вертолётные: … Многодневные: …»
 * рисовался абзацами, в чате не было ни одного пункта списка.
 * Промпт просит маркеры, чат узнаёт и маркеры, и строки «Заголовок: …».
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
