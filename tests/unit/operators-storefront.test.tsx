/**
 * Витрина компаний /operators — находка аудита 15.10 PAVEL-operators.
 *
 * Жалоба «Местечка Камчатка» (Павел) через владельца: «там 5 туркомпаний… я
 * там не выделяюсь. У меня основное — вертолётные экскурсии». Разбор нашёл
 * три дефекта витрины, и каждый проверяется здесь РЕНДЕРОМ с данными:
 *
 *   - по карточке нельзя было понять, чем компания занимается — теперь строка
 *     фактов о живых турах с числами («15 туров · Джип-сафари 8 · Вертолёт 5 ·
 *     Снегоход 2»); нет туров или посчитать не удалось — строки нет, а не
 *     «0 туров» (§4.0);
 *   - кнопки «Рыбалка», «Вертолётные туры»… фильтровали partners.category,
 *     где таких значений быть не может, и всегда давали «Операторы не
 *     найдены». Теперь кнопки — виды живых туров с числом компаний, из
 *     данных; вида без живого тура нет и кнопки;
 *   - старые ссылки `?category=…` не ломают страницу: список без фильтра.
 *
 * Перевозчик в списке и подсчёт живых туров судятся на настоящем PostgreSQL
 * (tests/integration/operators-list.pg.test.ts); отказ запроса фактов — вызовом
 * (tests/unit/operators-list-query.test.ts).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeOperatorTourRows, sortActivityCounts, tourFactsLine } from '@/lib/operators/tour-facts';

vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => React.createElement('img', { src: p.src, alt: p.alt }),
}));
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/operators',
}));

import OperatorsPageClient, { type Operator } from '@/app/operators/_OperatorsClient';

const ROOT = process.cwd();
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// Строки GROUP BY в произвольном порядке — как их отдаёт база.
const FACTS = summarizeOperatorTourRows([
  { operator_id: 'm', activity_type: 'snowmobile', n: 2 },
  { operator_id: 'm', activity_type: 'helicopter', n: 5 },
  { operator_id: 'm', activity_type: 'jeep_safari', n: 8 },
  { operator_id: 'f', activity_type: 'fishing', n: 10 },
]);

function op(id: string, name: string, extra: Partial<Operator> = {}): Operator {
  return {
    id, slug: `slug-${id}`, name, category: 'operator', shortDescription: null, heroImage: null,
    rating: 0, reviewCount: 0, isVerified: false,
    tourFacts: FACTS.get(id) ?? { total: 0, byActivity: [] },
    ...extra,
  };
}

const MESTECHKO = op('m', 'Местечко Камчатка');
const FISH = op('f', 'Камчатская рыбалка');
const EMPTY = op('e', 'Компания без туров');
const UNKNOWN = op('u', 'Факты не посчитаны', { tourFacts: null });
const ITEMS = [MESTECHKO, FISH, EMPTY, UNKNOWN];
const META = { total: 4, page: 1, limit: 12, pages: 1 };
const KEY = JSON.stringify({ search: '', activity: '', page: 1 });
const ACTIVITIES = sortActivityCounts([
  { activity_type: 'fishing', count: 1 },
  { activity_type: 'helicopter', count: 1 },
  { activity_type: 'jeep_safari', count: 1 },
  { activity_type: 'snowmobile', count: 1 },
]);

const fetchMock = vi.fn();

beforeEach(() => {
  window.history.replaceState({}, '', '/operators');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); replace.mockReset(); });

function renderPage(activities: typeof ACTIVITIES | null = ACTIVITIES) {
  return render(
    <OperatorsPageClient initialItems={ITEMS} initialMeta={META} initialKey={KEY} initialActivities={activities} />,
  );
}

const card = (name: string) => screen.getByText(name).closest('a') as HTMLElement;

describe('строка фактов о турах на карточке компании', () => {
  it('число живых туров и виды с числами, по убыванию числа', () => {
    renderPage();
    expect(within(card('Местечко Камчатка')).getByTestId('operator-tour-facts').textContent)
      .toBe('15 туров · Джип-сафари 8 · Вертолёт 5 · Снегоход 2');
    expect(within(card('Камчатская рыбалка')).getByTestId('operator-tour-facts').textContent)
      .toBe('10 туров · Рыбалка 10');
  });

  it('нет живых туров — строки нет, а не «0 туров»', () => {
    renderPage();
    const c = card('Компания без туров');
    expect(within(c).queryByTestId('operator-tour-facts')).toBeNull();
    expect(c.textContent).not.toMatch(/0 туров/);
  });

  it('факты посчитать не удалось (null) — карточка есть, строки нет', () => {
    renderPage();
    const c = card('Факты не посчитаны');
    expect(c.getAttribute('href')).toBe('/operators/slug-u');
    expect(within(c).queryByTestId('operator-tour-facts')).toBeNull();
  });

  it('склонение и равенство: «1 тур», «3 тура»; при равном числе — по подписи', () => {
    expect(tourFactsLine({ total: 1, byActivity: [{ activity_type: 'rafting', count: 1 }] })).toBe('1 тур · Сплав 1');
    const tie = summarizeOperatorTourRows([
      { operator_id: 'x', activity_type: 'jeep_safari', n: 1 },
      { operator_id: 'x', activity_type: 'helicopter', n: 1 },
      { operator_id: 'x', activity_type: null, n: 1 },
    ]).get('x');
    // Тур без вида входит в число, но не в разбивку.
    expect(tourFactsLine(tie)).toBe('3 тура · Вертолёт 1 · Джип-сафари 1');
    expect(tourFactsLine({ total: 0, byActivity: [] })).toBeNull();
    expect(tourFactsLine(null)).toBeNull();
  });
});

describe('кнопки фильтра — виды живых туров из данных', () => {
  it('«Вертолёт» есть, только если есть живой вертолётный тур, и несёт число компаний', () => {
    renderPage();
    const nav = screen.getByRole('navigation', { name: 'Виды туров' });
    const heli = within(nav).getByRole('link', { name: 'Вертолёт · 1' });
    expect(heli.getAttribute('href')).toBe('/operators?activity=helicopter');
    cleanup();

    renderPage(ACTIVITIES.filter((a) => a.activity_type !== 'helicopter'));
    const nav2 = screen.getByRole('navigation', { name: 'Виды туров' });
    expect(within(nav2).queryByRole('link', { name: /Вертолёт/ })).toBeNull();
    expect(within(nav2).getByRole('link', { name: 'Рыбалка · 1' })).toBeTruthy();
  });

  it('видов посчитать не удалось (null) — кнопок нет вовсе, список на месте', () => {
    renderPage(null);
    expect(screen.queryByRole('navigation', { name: 'Виды туров' })).toBeNull();
    expect(card('Местечко Камчатка')).toBeTruthy();
  });

  it('нажатие «Вертолёт» фильтрует: запрос с activity=helicopter, в выдаче только его компании', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ success: true, data: [MESTECHKO], meta: { total: 1, page: 1, limit: 12, pages: 1 }, activities: ACTIVITIES }),
    });
    renderPage();
    fireEvent.click(screen.getByRole('link', { name: 'Вертолёт · 1' }));
    await waitFor(() => expect(screen.queryByText('Камчатская рыбалка')).toBeNull());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(new URL(url, 'http://x').searchParams.get('activity')).toBe('helicopter');
    expect(url).not.toMatch(/category=/);
    expect(card('Местечко Камчатка')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Вертолёт · 1' }).getAttribute('aria-current')).toBe('true');
    expect(replace).toHaveBeenCalledWith('/operators?activity=helicopter', { scroll: false });
  });
});

describe('адрес фильтра читается при входе', () => {
  it('?activity=helicopter — фильтр применён', async () => {
    window.history.replaceState({}, '', '/operators?activity=helicopter');
    fetchMock.mockResolvedValue({
      json: async () => ({ success: true, data: [MESTECHKO], meta: { total: 1, page: 1, limit: 12, pages: 1 }, activities: ACTIVITIES }),
    });
    renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(new URL(String(fetchMock.mock.calls[0][0]), 'http://x').searchParams.get('activity')).toBe('helicopter');
  });

  it('старая ссылка ?category=fishing — список без фильтра, лишнего запроса нет', async () => {
    window.history.replaceState({}, '', '/operators?category=fishing');
    renderPage();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    for (const o of ITEMS) expect(card(o.name)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Все' }).getAttribute('aria-current')).toBe('true');
  });

  it('незнакомый вид ?activity=whale_watching — без фильтра, не пустая выдача', async () => {
    window.history.replaceState({}, '', '/operators?activity=whale_watching');
    renderPage();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(card('Местечко Камчатка')).toBeTruthy();
  });
});

describe('честность витрины (CLAUDE.md §0)', () => {
  it('правило порядка названо на странице', () => {
    renderPage();
    expect(screen.getByText('Компании идут по алфавиту. Место в списке не продаётся.')).toBeTruthy();
  });

  it('синонимы вида у компании — одна позиция в строке фактов', () => {
    const facts = summarizeOperatorTourRows([
      { operator_id: 'x', activity_type: 'jeep', n: 3 },
      { operator_id: 'x', activity_type: 'jeep_safari', n: 2 },
    ]).get('x');
    expect(tourFactsLine(facts)).toBe('5 туров · Джип-сафари 5');
  });

  it('база не ответила (degraded) — «не загрузился», прежний список на месте, не «не найдены»', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ success: true, data: [], meta: { total: 0, page: 1, limit: 12, pages: 0 }, activities: null, degraded: true }),
    });
    renderPage();
    fireEvent.click(screen.getByRole('link', { name: 'Вертолёт · 1' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('не загрузился'));
    expect(screen.queryByText('Операторы не найдены')).toBeNull();
    expect(card('Местечко Камчатка')).toBeTruthy();
  });

  it('сеть упала — то же «не загрузился», а не тишина', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('network'));
    renderPage();
    fireEvent.click(screen.getByRole('link', { name: 'Вертолёт · 1' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('не загрузился'));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('запреты', () => {
  it('захардкоженного списка «категорий»-видов на витрине больше нет', () => {
    const src = code(readFileSync(join(ROOT, 'app/operators/_OperatorsClient.tsx'), 'utf-8'));
    expect(src).not.toMatch(/Вертолётные туры|whale_watching|const CATEGORIES/);
    // Фильтр по partners.category из запроса списка снят: таких значений там нет.
    const q = code(readFileSync(join(ROOT, 'lib/operators/list-query.ts'), 'utf-8'));
    expect(q).not.toMatch(/category = \$/);
  });
});
