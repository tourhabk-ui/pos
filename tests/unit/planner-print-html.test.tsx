/**
 * «Скачать PDF» на /planner: документ пишется в окно того же источника, что
 * сайт, через document.write. Название и описание тура пишет оператор — роль
 * с самостоятельной регистрацией. До разбора 06.11 они попадали в документ
 * разметкой: тур с `<img onerror>` в названии выполнял чужой скрипт у туриста.
 *
 * Проверка — исполнением: сама сборка (lib/planner/print-html) на враждебных
 * значениях и экран целиком — рендер планера, нажатие «Скачать PDF», перехват
 * записанного документа.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import React from 'react';
import { buildPlanPrintHtml, type PrintPlanInput } from '@/lib/planner/print-html';
import { dayPriceLine } from '@/lib/planner/day-price';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function MapStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));

import { PlannerClient } from '@/app/planner/_PlannerClient';

const HOSTILE_TITLE = 'Тур <img src=x onerror="window.top.__x=1">';
const HOSTILE_DESC = '<script>window.__y=1</script>Описание';
const HOSTILE_WARN = '<b onmouseover="x()">предупреждение</b>';

/** Разметка, которой в документе быть не должно, — как её прочитал бы браузер. */
function rawTags(html: string): string[] {
  return [...html.matchAll(/<(img|script|b|iframe|svg)\b/gi)].map((m) => m[0]);
}

describe('сборка документа экранирует каждое значение', () => {
  const base: PrintPlanInput = {
    dateRange: '2030-08-03 — 2030-08-05',
    adults: 2,
    childAges: [7],
    days: [{
      num: 1, confirmed: true, title: HOSTILE_TITLE, badge: '<i>бейдж</i>', priceLine: 'от 13 000 ₽ <u>',
      description: HOSTILE_DESC, meta: 'Авачинская зона | <s>', warnings: [HOSTILE_WARN],
    }],
    estimate: {
      people: 2,
      lines: [{ label: 'Жильё <img src=y>', basis: '2 ночи', source: 'offer', total: [1000, 2000] }],
      total: [1000, 2000], perPerson: [500, 1000], assumptions: ['<script>z()</script>'],
    },
    warnings: [{ severity: 'critical" onclick="evil()', message: HOSTILE_WARN }],
    fmt: (n) => n.toLocaleString('ru-RU'),
  };

  it('ни название, ни описание, ни предупреждения, ни строки сметы не становятся разметкой', () => {
    const html = buildPlanPrintHtml(base);
    expect(rawTags(html)).toEqual([]);
    expect(html).toContain('Тур &lt;img src=x onerror=&quot;window.top.__x=1&quot;&gt;');
    expect(html).toContain('&lt;script&gt;window.__y=1&lt;/script&gt;Описание');
    // Класс строки — только из закрытого списка: чужое значение не выходит из атрибута.
    expect(html).not.toContain('onclick');
    expect(html).toContain('class="warning warning-info"');
  });

  it('обычный план читается как прежде: номер, название, цена, смета', () => {
    const html = buildPlanPrintHtml({
      ...base,
      days: [{ num: 2, confirmed: false, title: 'Паратунка', badge: 'Тур оператора', priceLine: 'от 13 000 ₽', description: 'Купание', meta: 'Авачинская зона', warnings: [] }],
      warnings: [{ severity: 'important', message: 'Медведи' }],
    });
    expect(html).toContain('<div class="day-num">2</div>');
    expect(html).toContain('<div class="day-title">Паратунка</div>');
    expect(html).toContain('<span class="day-badge">Тур оператора</span>');
    expect(html).toContain('1 000 — 2 000 ₽');
    expect(html).toContain('class="warning warning-important">Медведи</div>');
  });

  it('смета без вилки — одна сумма, а не «X — X ₽» (#3199, E12)', () => {
    const html = buildPlanPrintHtml({
      ...base,
      estimate: {
        ...base.estimate!,
        lines: [{ label: 'Тур', basis: '10 000 ₽ × 2 чел.', source: 'tour', total: [20000, 20000] }],
        total: [20000, 20000], perPerson: [10000, 10000],
      },
    }).replace(/[\u00a0\u202f]/g, ' ');
    expect(html).toContain('<span>20 000 ₽</span>');
    expect(html).toContain('<span>10 000 ₽</span>');
    expect(html).not.toContain('20 000 — 20 000');
  });

  it('в компоненте планера нет своего HTML-документа: он собирается только здесь', () => {
    const src = readFileSync('app/planner/_PlannerClient.tsx', 'utf-8');
    expect(src).not.toMatch(/<!DOCTYPE html>/i);
  });
});

describe('экран: «Скачать PDF» не пишет чужую разметку в документ', () => {
  const PKC: [number, number] = [53.01, 158.65];
  const day = (n: number, type: string, extra: Record<string, unknown> = {}) => ({
    day: n, type, zone: 'avachinsky', title: `День ${n}`, description: '', activityType: 'hot_spring',
    priceFrom: 0, priceTo: 0, coords: PKC, defaultTransport: 'walking', allowedTransports: ['walking'],
    difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
  });
  const PRICES = { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] };
  const recommendation = {
    zones: [], itinerary: '', priceBreakdown: PRICES,
    warnings: [{ type: 'mchs', severity: 'important', message: HOSTILE_WARN }],
    days: [
      day(1, 'arrival', { title: 'Прилёт' }),
      day(2, 'activity', { title: HOSTILE_TITLE, description: HOSTILE_DESC, dayWarnings: [HOSTILE_WARN], priceFrom: 13000, priceTo: 15000 }),
      day(3, 'departure', { title: 'Вылет' }),
    ],
  };

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json } as Response);
      if (u.startsWith('/api/planner/recommend')) return ok({ success: true, data: recommendation });
      if (u.startsWith('/api/planner/tours-for-day')) return ok({ success: true, tours: [] });
      return ok({ success: true, data: [] });
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('день с враждебным названием и описанием попадает в документ текстом', async () => {
    render(<PlannerClient />);
    const next = () => fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));
    fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
    fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-05' } });
    next(); next(); next();
    fireEvent.click(screen.getByRole('button', { name: /Термальные/ }));
    fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
    await screen.findByText(/кликните день для редактирования/);
    // Цена дня в документе — та же подпись, что у карточки и страницы плана
    // (lib/planner/day-price, planner-day-price.test.ts).
    const priceLine = dayPriceLine({ priceFrom: 13000, priceTo: 15000 });
    expect(priceLine).not.toBe('');

    const written: string[] = [];
    vi.spyOn(window, 'open').mockReturnValue({
      document: { write: (s: string) => written.push(s), close: () => {} }, print: () => {},
    } as unknown as Window);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: /Скачать PDF маршрута/ }));
    } finally {
      vi.useRealTimers();
    }
    const html = written.join('');
    expect(html).toContain('Маршрут по Камчатке');
    expect(rawTags(html)).toEqual([]);
    expect(html).toContain('&lt;img src=x onerror=');
    expect(html).toContain(`<span class="day-price">${priceLine}</span>`);
  });
});
