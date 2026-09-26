/**
 * Сторож: анкета /planner — четыре коротких шага (решение владельца 26.09),
 * и новое, что в них появилось, доходит до движка.
 *
 * Держит связку целиком, на настоящем компоненте:
 *   — шаги идут в порядке «Когда → Кто едет → Как хотите ехать → Что
 *     интересно», с прогрессом «Шаг N из 4» и кнопками «Назад» / «Дальше» /
 *     «Собрать маршрут»;
 *   — без дат дальше первого шага не пускает и говорит почему (движок без
 *     дат собирает пустой план);
 *   — здоровье, подвижность, стиль и дни отдыха уходят в запрос
 *     /api/planner/recommend;
 *   — заметки движка о стиле и отдыхе показываются на экране результата;
 *   — корень экрана стоит под шапкой сайта (полоса «План / Карта» лежала
 *     поверх её иконок), и панель шагов поднимает кнопку «Подобрать тур».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));

import { PlannerClient } from '@/app/planner/_PlannerClient';
import { PAGE_ACTION_BAR_VAR } from '@/components/shared/StickyLeadButton';
import { PLANNER_HEADER_OFFSET } from '@/app/planner/planner-layout';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[] = [];

const RECOMMENDATION = {
  zones: [], days: [], warnings: [],
  priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] },
  itinerary: '',
  preferences: {
    travelStyle: 'self', restDaysRequested: 1, restDaysPlanned: 1,
    notes: [
      { topic: 'travel_style', status: 'partial', message: 'Самостоятельно не ставим: вулканы: высокий риск (восхождение на вулкан).' },
      { topic: 'rest_days', status: 'honoured', message: 'Дней отдыха в плане: 1.' },
    ],
  },
};

let chatReply: Record<string, unknown> = {};

beforeEach(() => {
  calls = [];
  chatReply = { success: true, places: ['volcano'], activities: [], arrival: null, departure: null, auto_recommend: true, travel_style: 'self', rest_days: 2 };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url: String(url), body });
    const json = String(url).startsWith('/api/planner/recommend')
      ? { success: true, data: RECOMMENDATION }
      : String(url).startsWith('/api/planner/chat')
        ? chatReply
        : { success: true, data: [], tours: [] };
    return { ok: true, json: async () => json } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const next = () => fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));
const heading = () => screen.getByRole('heading', { level: 1 }).textContent;

function fillDates() {
  fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
  fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-12' } });
}

describe('четыре шага по порядку', () => {
  it('Когда → Кто едет → Как хотите ехать → Что интересно', () => {
    render(<PlannerClient />);
    expect(screen.getByText('Шаг 1 из 4')).toBeTruthy();
    expect(heading()).toBe('Когда');
    // Быстрый путь — сверху первого шага.
    expect(screen.getByLabelText(/Опишите поездку/)).toBeTruthy();
    fillDates();
    expect(screen.getByText('9 дней на Камчатке')).toBeTruthy();
    next();
    expect(screen.getByText('Шаг 2 из 4')).toBeTruthy();
    expect(heading()).toBe('Кто едет');
    next();
    expect(heading()).toBe('Как хотите ехать');
    next();
    expect(heading()).toBe('Что интересно');
    expect(screen.getByText('Шаг 4 из 4')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Собрать маршрут/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Назад/ }));
    expect(heading()).toBe('Как хотите ехать');
  });

  it('без дат дальше первого шага не пускает и говорит почему', () => {
    render(<PlannerClient />);
    next();
    expect(heading()).toBe('Когда');
    expect(screen.getByRole('alert').textContent).toMatch(/даты прилёта и отъезда/);
  });

  it('новые поля стоят на своих шагах', () => {
    render(<PlannerClient />);
    fillDates();
    next();
    expect(screen.getByLabelText(/Ограничения по здоровью/)).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Подвижность' })).toBeTruthy();
    expect(screen.getByText(/Укачивает на воде/)).toBeTruthy();
    next();
    const style = screen.getByRole('radiogroup', { name: 'Как ехать' });
    expect(within(style).getAllByRole('radio').map((b) => b.querySelector('span')?.textContent))
      .toEqual(['Сам', 'С оператором', 'Вперемешку']);
    // По умолчанию — «Вперемешку»: прежнее поведение движка.
    expect(within(style).getByRole('radio', { checked: true }).textContent).toMatch(/^Вперемешку/);
    expect(screen.getByLabelText('Больше дней отдыха')).toBeTruthy();
    // Режим маршрутов — как был.
    expect(screen.getByText('Режим маршрутов')).toBeTruthy();
    next();
    expect(screen.getByText('Места')).toBeTruthy();
    expect(screen.getByText('Активности')).toBeTruthy();
  });
});

describe('новое доходит до движка', () => {
  it('здоровье, подвижность, стиль и дни отдыха — в запросе recommend', async () => {
    render(<PlannerClient />);
    fillDates();
    next();
    fireEvent.change(screen.getByLabelText(/Ограничения по здоровью/), { target: { value: 'колено, астма' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Подвижность' })).getByRole('radio', { name: 'Ограниченная' }));
    next();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Как ехать' })).getAllByRole('radio')[0]);
    fireEvent.click(screen.getByLabelText('Больше дней отдыха'));
    next();
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/planner/recommend')).toBe(true));
    const body = calls.find((c) => c.url === '/api/planner/recommend')?.body ?? {};
    expect(body.healthNotes).toBe('колено, астма');
    expect(body.mobilityLevel).toBe('limited');
    expect(body.travelStyle).toBe('self');
    expect(body.restDays).toBe(1);
    expect(body.interests).toEqual(['volcano']);

    // Заметки движка — на экране результата.
    await waitFor(() => expect(screen.getByText('Ваши пожелания')).toBeTruthy());
    expect(screen.getByText(/Самостоятельно не ставим/)).toBeTruthy();
    expect(screen.getByText('Дней отдыха в плане: 1.')).toBeTruthy();
  });

  it('здоровье не уходит в разбор фразы (там модель), даже если заполнено', async () => {
    render(<PlannerClient />);
    fillDates();
    next();
    fireEvent.change(screen.getByLabelText(/Ограничения по здоровью/), { target: { value: 'астма' } });
    fireEvent.click(screen.getByRole('button', { name: /Назад/ }));
    fireEvent.change(screen.getByLabelText(/Опишите поездку/), { target: { value: 'вулканы, сами, 2 дня отдыха' } });
    fireEvent.click(screen.getByRole('button', { name: 'Разобрать описание' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/planner/chat')).toBe(true));
    const chat = calls.find((c) => c.url === '/api/planner/chat');
    expect(Object.keys(chat?.body ?? {})).toEqual(['message']);
    expect(JSON.stringify(chat?.body)).not.toContain('астма');
    // auto_recommend + даты — маршрут собирается сразу, с разобранным стилем и
    // отдыхом, а не со старым замыканием.
    await waitFor(() => expect(calls.some((c) => c.url === '/api/planner/recommend')).toBe(true));
    const rec = calls.find((c) => c.url === '/api/planner/recommend')?.body ?? {};
    expect(rec.interests).toEqual(['volcano']);
    expect(rec.travelStyle).toBe('self');
    expect(rec.restDays).toBe(2);
    // В остальные адреса здоровье не уходит никогда.
    for (const c of calls.filter((x) => x.url !== '/api/planner/recommend')) {
      expect(JSON.stringify(c.body ?? {}), c.url).not.toContain('астма');
    }
  });

  it('фраза без дат не собирает маршрут и дат не выдумывает', async () => {
    render(<PlannerClient />);
    fireEvent.change(screen.getByLabelText(/Опишите поездку/), { target: { value: 'вулканы' } });
    fireEvent.click(screen.getByRole('button', { name: 'Разобрать описание' }));
    await waitFor(() => expect(screen.getByText(/Осталось выбрать даты/)).toBeTruthy());
    expect(calls.some((c) => c.url === '/api/planner/recommend')).toBe(false);
    expect(heading()).toBe('Когда');
    expect((screen.getByLabelText('Дата прилёта') as HTMLInputElement).value).toBe('');
  });
});

describe('шапка сайта и кнопка заявки', () => {
  it('корень экрана — под шапкой, тем же отступом, что .ds-page', () => {
    const css = read('app/globals.css');
    const dsPage = css.match(/\.ds-page\s*\{[^}]*padding-top:\s*([^;]+);/);
    expect(dsPage?.[1].trim()).toBe(PLANNER_HEADER_OFFSET);
    const { container } = render(<PlannerClient />);
    const root = container.querySelector('[data-planner-root]') as HTMLElement;
    expect(root).toBeTruthy();
    // jsdom переписывает env() по-своему — сверяем высоту и исходник.
    expect(root.style.paddingTop).toContain('64px');
    const src = read('app/planner/_PlannerClient.tsx');
    const at = src.indexOf('<div data-planner-root');
    expect(src.slice(at, at + 300)).toContain('paddingTop: PLANNER_HEADER_OFFSET');
    expect(root.style.boxSizing).toBe('border-box');
    // Полоса «План / Карта» — внутри корня и не прибита к верху окна.
    const planTab = screen.getByRole('button', { name: /^План$/ });
    expect(root.contains(planTab)).toBe(true);
    let el: HTMLElement | null = planTab;
    while (el && el !== root) {
      expect(el.className, 'полоса вкладок снова прибита к окну').not.toMatch(/\b(fixed|sticky)\b/);
      el = el.parentElement;
    }
  });

  it('панель шагов публикует свою высоту, кнопка «Подобрать тур» её учитывает', () => {
    const { unmount } = render(<PlannerClient />);
    expect(document.documentElement.style.getPropertyValue(PAGE_ACTION_BAR_VAR)).toMatch(/^\d+(\.\d+)?px$/);
    unmount();
    expect(document.documentElement.style.getPropertyValue(PAGE_ACTION_BAR_VAR)).toBe('');
    const fab = read('components/shared/StickyLeadButton.tsx');
    expect(fab).toMatch(/const FAB_BOTTOM = `calc\([^`]*var\(\$\{PAGE_ACTION_BAR_VAR\}, 0px\)/);
    // Кнопку на /planner не прячут — владелец её оставил.
    expect(fab).not.toMatch(/HIDDEN_PATHS = \[[^\]]*'\/planner'/);
  });

  it('последнее поле шага прокручивается выше полосы и кнопки «Подобрать тур»', () => {
    const src = read('app/planner/_PlannerClient.tsx');
    const layout = read('app/planner/planner-layout.ts');
    // Запас = высота полосы (переменная) + место под кнопку над ней.
    expect(layout).toMatch(/CONTENT_BOTTOM_CLEARANCE = 'calc\(var\(--page-action-bar-h, 0px\) \+ \d{3}px\)'/);
    expect((src.match(/paddingBottom: CONTENT_BOTTOM_CLEARANCE/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/px-4 pt-5 pb-28/);
  });
});

describe('здоровье — только в recommend (по коду)', () => {
  it('в клиенте healthNotes уходит одним fetch — в /api/planner/recommend', () => {
    const src = read('app/planner/_PlannerClient.tsx');
    const chunks = src.split(/fetch\(/).slice(1);
    const carrying = chunks.filter((c) => /healthNotes|mobilityLevel/.test(c.slice(0, 1500)))
      .map((c) => c.match(/^\s*[`'"]([^`'"?]+)/)?.[1]);
    expect(carrying).toEqual(['/api/planner/recommend']);
  });

  it('роут разбора фразы здоровья не принимает', () => {
    const chat = read('app/api/planner/chat/route.ts');
    const schema = chat.slice(chat.indexOf('const BodySchema'), chat.indexOf('});', chat.indexOf('const BodySchema')));
    expect(schema).not.toMatch(/health|mobility/i);
  });
});
