// @vitest-environment jsdom
/**
 * /for-operators без чисел и обещаний, которых нечем подтвердить (владелец 23.11).
 *
 * Страница показывала «131 маршрутов в базе знаний», «13 туров в каталоге» и
 * «Первые 3 месяца бесплатно». Числа были вписаны в вёрстку и с базой не
 * сверялись (маршрутов и туров давно другое число), а «три месяца бесплатно»
 * подразумевает плату после них — такого условия у платформы нет.
 * Судится рендером обоих блоков страницы.
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { OperatorPromo } from '@/components/homepage/OperatorPromo';
import { AgentModelSection } from '@/components/homepage/AgentModelSection';

afterEach(() => cleanup());

const pageText = () => {
  const { container } = render(<><OperatorPromo headingLevel="h1" /><AgentModelSection /></>);
  return container.textContent ?? '';
};

describe('/for-operators', () => {
  it('нет чисел маршрутов и туров, вписанных в вёрстку', () => {
    const t = pageText();
    expect(t).not.toMatch(/131/);
    expect(t).not.toMatch(/маршрутов в базе знаний/);
    expect(t).not.toMatch(/туров в каталоге/);
    expect(t).not.toMatch(/\b13\s*туров/);
  });

  it('нет «трёх месяцев бесплатно»', () => {
    const t = pageText();
    expect(t).not.toMatch(/3 месяца/);
    expect(t).not.toMatch(/бесплатно/i);
  });

  it('то, что о платформе правда, осталось: каналы и удержания', () => {
    const t = pageText();
    expect(t).toContain('канала привлечения');
    expect(t).toContain('удержаний из оплаты туриста');
    expect(t).toContain('Регистрация за 5 минут');
    expect(t).toContain('Условия работы — в публичной оферте для партнёров');
  });

  it('заголовок страницы один, кнопки регистрации на месте', () => {
    const { container } = render(<><OperatorPromo headingLevel="h1" /><AgentModelSection /></>);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/operators/join');
  });
});
