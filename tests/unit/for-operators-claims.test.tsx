// @vitest-environment jsdom
/**
 * /for-operators: числа — из базы, обещаний без источника нет (план готовности
 * 23.11, этап 1).
 *
 * Страница показывала «131 маршрутов в базе знаний» и «13 туров в каталоге»
 * текстом в вёрстке (живых туров был 81) и «Первые 3 месяца бесплатно» — срок,
 * после которого подразумевается плата; такого условия у платформы нет.
 * Теперь числа маршрутов и туров приходят из `getPlatformCounts` — того же
 * источника, что у главной и /operators/join; не посчитали или ноль — плитки
 * нет. Судится рендером блоков и самой страницы.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { OperatorPromo } from '@/components/homepage/OperatorPromo';
import { AgentModelSection } from '@/components/homepage/AgentModelSection';

const { getPlatformCounts } = vi.hoisted(() => ({ getPlatformCounts: vi.fn() }));
vi.mock('@/lib/stats/platform-counts', () => ({ getPlatformCounts }));
// Шапка сайта — своя вёрстка со своими сторожами; здесь судится тело страницы.
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

afterEach(() => cleanup());

const COUNTS = { routes: 366, places: 379, mchsRoutes: 154, safetyProfiles: 763, placesByType: {}, storefrontTours: 81 };

/** Плитки чисел: значение и подпись, как их видит человек. */
const tiles = (container: HTMLElement) =>
  [...container.querySelectorAll('p.text-3xl')].map((v) => `${v.textContent} ${v.nextElementSibling?.textContent ?? ''}`);

describe('блок модели: числа каталога', () => {
  it('маршруты и туры — те числа, что пришли с сервера, со склонением', () => {
    const { container } = render(<AgentModelSection catalog={{ routes: 366, tours: 81 }} />);
    expect(tiles(container)).toEqual([
      '366 маршрутов в базе знаний',
      '81 тур в каталоге',
      '3 канала входа: сайт, Telegram, MAX',
      '0% удержаний из оплаты туриста',
    ]);
  });

  it('другие числа — другой текст: в вёрстку числа не вписаны', () => {
    const { container } = render(<AgentModelSection catalog={{ routes: 402, tours: 94 }} />);
    const t = tiles(container);
    expect(t[0]).toBe('402 маршрута в базе знаний');
    expect(t[1]).toBe('94 тура в каталоге');
    expect(container.textContent).not.toMatch(/\b(131|13|366|81)\b/);
  });

  it('не посчитали — плиток маршрутов и туров нет, а не «0»', () => {
    for (const catalog of [null, undefined, { routes: 0, tours: 0 }]) {
      const { container } = render(<AgentModelSection catalog={catalog} />);
      expect(tiles(container)).toEqual(['3 канала входа: сайт, Telegram, MAX', '0% удержаний из оплаты туриста']);
      expect(container.textContent).not.toMatch(/в базе знаний|в каталоге/);
      cleanup();
    }
  });

  it('ноль туров при живых маршрутах: плитка маршрутов есть, плитки туров нет', () => {
    const { container } = render(<AgentModelSection catalog={{ routes: 366, tours: 0 }} />);
    expect(tiles(container)).toEqual([
      '366 маршрутов в базе знаний',
      '3 канала входа: сайт, Telegram, MAX',
      '0% удержаний из оплаты туриста',
    ]);
  });
});

describe('/for-operators: обещаний без источника нет', () => {
  const pageText = () => {
    const { container } = render(<><OperatorPromo headingLevel="h1" /><AgentModelSection catalog={{ routes: 366, tours: 81 }} /></>);
    return container.textContent ?? '';
  };

  it('нет «трёх месяцев бесплатно» и другого срока или тарифа взамен', () => {
    const t = pageText();
    expect(t).not.toMatch(/месяц/i);
    expect(t).not.toMatch(/бесплатно/i);
    expect(t).not.toMatch(/тариф/i);
    expect(t).toContain('Условия работы — в публичной оферте для партнёров');
  });

  it('слова «в цифрах» не стоят над списком, в котором цифр нет', () => {
    expect(pageText()).not.toMatch(/в цифрах/i);
  });

  it('каналы названы как факт продукта, а не как отчёт', () => {
    const t = pageText();
    expect(t).toContain('канала входа: сайт, Telegram, MAX');
    expect(t).not.toContain('канала привлечения');
  });

  it('заголовок страницы один, кнопки регистрации на месте', () => {
    const { container } = render(<><OperatorPromo headingLevel="h1" /><AgentModelSection /></>);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/operators/join');
    expect(hrefs).toContain('/legal/offer');
  });
});

describe('страница /for-operators берёт числа из getPlatformCounts', () => {
  // Каждый тест задаёт ответ счётчика сам: общий сброс мока перед тестом
  // здесь не нужен.
  const renderPage = async () => {
    const mod = await import('@/app/for-operators/page');
    return { mod, ...render(await mod.default()) };
  };

  it('туры — счёт витрины (storefrontTours), маршруты — routes', async () => {
    getPlatformCounts.mockResolvedValue(COUNTS);
    const { container, mod } = await renderPage();
    expect(tiles(container).slice(0, 2)).toEqual(['366 маршрутов в базе знаний', '81 тур в каталоге']);
    // Сборка Docker идёт без базы: страница рендерится на запрос.
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('подменили счётчик — текст страницы изменился', async () => {
    getPlatformCounts.mockResolvedValue({ ...COUNTS, routes: 5, storefrontTours: 2 });
    const { container } = await renderPage();
    expect(tiles(container).slice(0, 2)).toEqual(['5 маршрутов в базе знаний', '2 тура в каталоге']);
  });

  it('база не ответила: страница открывается без чисел, отказ — в логе', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    getPlatformCounts.mockImplementation(async () => { throw new Error('connect ECONNREFUSED'); });
    const { container } = await renderPage();
    expect(tiles(container)).toEqual(['3 канала входа: сайт, Telegram, MAX', '0% удержаний из оплаты туриста']);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(err).toHaveBeenCalledWith('[for-operators] счётчики не получены', 'connect ECONNREFUSED');
    err.mockRestore();
  });
});
