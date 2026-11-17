/**
 * Один тур — одни факты на всех поверхностях (#3487, 17.11).
 *
 * Повод — сверка карточки тура, `/api/tours/[id]` и MCP по живым турам:
 *   - цена: карточка «97 000 ₽ за человека», MCP «от 97 000 ₽/чел.» — «от»
 *     выдумал форматтер, у тура одна цена;
 *   - группа: у тура «1–8» API отдавал 20 (читал колонку под чужим именем);
 *   - длительность: «3 ч» в блоке туров места и «1 день» на карточке у
 *     одного тура;
 *   - сезон: календарь API открывал ноябрь 2026 у тура сезона 2027;
 *   - отмена: фраза о возврате в правилах безопасности тура, а форма заявки и
 *     MCP писали «не записаны»;
 *   - «Что включено» собирало входящее и невходящее под одним заголовком.
 *
 * Правда — в `operator_tours`: каждая поверхность печатает поле одной
 * функцией и одними словами, MCP ничего не добавляет. Сторож судит вызовом и
 * рендером: карточка и блок туров места — @testing-library/react, API и MCP —
 * настоящие обработчики и сборщики ответа над подставной базой. Туры и
 * компании выдуманы; личных данных туристов здесь нет.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';

const { poolQuery, dbQuery } = vi.hoisted(() => ({ poolQuery: vi.fn(), dbQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: poolQuery, connect: vi.fn(async () => ({ query: poolQuery, release: vi.fn() })) },
  transaction: vi.fn(),
}));
vi.mock('@/lib/database', () => ({ query: dbQuery }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/9001',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

import { NextRequest } from 'next/server';
import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';
import PlaceTours from '@/components/places/PlaceTours';
import type { PlaceTour } from '@/components/places/types';
import { GET as tourApi } from '@/app/api/tours/[id]/route';
import { GET as availabilityApi } from '@/app/api/tours/[id]/availability/route';
import { getTourDetails } from '@/lib/kuzmich/core';
import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';
import { priceSum, priceUnitWords, priceWithUnitWords } from '@/lib/tours/price-label';
import { cardDuration } from '@/lib/tours/card-facts';
import { calendarRangeOf, tourSeasonWords, SEASON_NOT_RECORDED } from '@/lib/tours/season-words';
import { SAFETY_NOTES_CANCELLATION_HEAD } from '@/lib/tours/cancellation-words';
import { groupClaimConflicts, groupClaimConflictLine } from '@/lib/tours/description-conflicts';

/* ─── Фикстуры: строки operator_tours, как их отдаёт драйвер ─── */

interface Fixture {
  id: number;
  title: string;
  description: string;
  base_price: string;
  price_unit: string | null;
  duration_type: string | null;
  duration_hours: string | null;
  multi_day_count: number | null;
  /** Драйвер отдаёт integer числом, но бывает и строкой — оба случая ниже. */
  max_participants: number | string;
  min_participants: number | string | null;
  season_start: string | null;
  season_end: string | null;
  cancellation_policy: string | null;
  safety_notes: string[];
  included: string[];
  not_included: string[];
  program: unknown;
  /** Первая и последняя дата календаря оператора; нет — null. */
  cal: { first: string; last: string } | null;
}

/** Цена за человека, тур на несколько часов, группа 1–18, сезон 2027, отмена — в правилах безопасности. */
const UZON: Fixture = {
  id: 9001, title: 'Кальдера Узон на вертолёте', description: 'Облёт кальдеры с посадкой.',
  base_price: '97000.00', price_unit: 'per_person', duration_type: 'day', duration_hours: '3', multi_day_count: null,
  max_participants: 18, min_participants: 1, season_start: '2027-06-01', season_end: '2027-09-30',
  cancellation_policy: null,
  safety_notes: [
    'Вылет зависит от погоды: возможны задержки, переносы и отмены.',
    'При отмене экскурсии из-за погоды деньги возвращаются в полном объёме.',
  ],
  included: ['Перелёт', 'Обед'], not_included: ['Экологический сбор'],
  program: [{ title: 'Вылет из Елизова', text: 'Сбор на вертодроме в 8:00.' }, { title: 'Кальдера', text: 'Прогулка по тропе.' }],
  cal: null,
};

/** Цена за группу, многодневный, группа 1–8 строкой, сезона нет, календарь есть, описание спорит с группой. */
const PERVAL: Fixture = {
  id: 9002, title: 'Вилючинский перевал, пять дней', description: 'Поход с ночёвками. Группа от 4 человек.',
  base_price: '140000', price_unit: 'per_tour', duration_type: 'multi_day', duration_hours: null, multi_day_count: 5,
  max_participants: '8', min_participants: '1', season_start: null, season_end: null,
  cancellation_policy: 'Бесплатная отмена за 3 дня до тура.\nПозже удерживается 50%.',
  safety_notes: [], included: ['Снаряжение'], not_included: ['Перелёт до Петропавловска'],
  program: ['День 1. Заброска', { title: 'День 2', text: 'Подъём на перевал.' }],
  cal: { first: '2026-12-05', last: '2027-03-20' },
};

/** Сезона нет и календаря нет: заявка на любой день, но не «свободные даты сезона». */
const NOSEASON: Fixture = {
  ...PERVAL, id: 9003, title: 'Нерка на Курильском озере', description: 'Наблюдение за медведями.',
  base_price: '45000', price_unit: null, duration_type: 'day', duration_hours: '10', multi_day_count: null,
  max_participants: 12, min_participants: null, cancellation_policy: null, cal: null,
};

const FIXTURES = [UZON, PERVAL, NOSEASON];

/* ─── Подставная база ─── */

/** Строка тура в той форме, в какой её читает каждая поверхность. */
function dbRow(f: Fixture): Record<string, unknown> {
  return {
    ...f, slug: null, short_description: null, price_old: null, activity_type: 'trekking', location_type: 'volcano',
    location_name: 'Камчатка', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
    pickup_details: null, tour_image: null, photos: [], what_to_bring: null, group_size_unlimited: false,
    seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, reviews_count: 0,
    operator_id: 'op-test', operator_name: 'Тестовая компания', operator_contacts: null, is_active: true,
    // /api/tours/[id] — свои алиасы дат сезона и календаря.
    season_start_day: f.season_start, season_end_day: f.season_end,
    cal_first: f.cal?.first ?? null, cal_last: f.cal?.last ?? null,
    // availability — свои алиасы колонок.
    name: f.title, price: f.base_price, max_group_size: f.max_participants, min_group_size: f.min_participants,
    // created_at для /api/tours/[id].
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}

let current: Fixture = UZON;

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** MCP и Кузьмич читают пулом: резолвер по номеру, детали, расписание. */
poolQuery.mockImplementation(async (sql: string) => {
  // Тур читается по номеру — резолвером (`ot.id = $1`) и деталями (`id = $1`).
  if (/FROM operator_tours/.test(sql) && /(WHERE|AND) (ot\.)?id = \$1/.test(sql)) return { rows: [dbRow(current)] };
  if (/SELECT EXISTS/.test(sql)) return { rows: [{ has: false }] };
  return { rows: [] };
});

/** API читает через lib/database: тур, строки календаря, ряд дат с занятостью. */
dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
  if (/date_series/.test(sql)) {
    const [from, to] = params as string[];
    return { rows: eachDay(from, to).map((d) => ({ date: d, booked: 0, max_capacity: 18, spots_left: '18', status: 'available' })) };
  }
  if (/FROM tour_availability ta\s+WHERE ta\.operator_tour_id = \$1/.test(sql)) return { rows: [] };
  if (/FROM operator_tours/.test(sql)) return { rows: [dbRow(current)] };
  return { rows: [] };
});

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T02:00:00Z'));
});
afterAll(() => { vi.useRealTimers(); });
afterEach(() => { cleanup(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

/* ─── Поверхности ─── */

const flat = (s: string | null | undefined) => (s ?? '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

function renderCard(f: Fixture): HTMLElement {
  current = f;
  const tour = { ...dbRow(f), max_participants: Number(f.max_participants), min_participants: f.min_participants == null ? null : Number(f.min_participants) };
  const { container } = render(
    <TourDetailClient tour={tour as unknown as React.ComponentProps<typeof TourDetailClient>['tour']}
      reviews={[]} calendarRange={calendarRangeOf(f.cal?.first, f.cal?.last)} />,
  );
  return container;
}

function renderPlaceBlock(f: Fixture): HTMLElement {
  const t: PlaceTour = {
    id: String(f.id), title: f.title, slug: null, partnerId: 'op-test', operatorName: 'Тестовая компания',
    basePrice: Number(f.base_price), priceUnit: f.price_unit, durationType: f.duration_type,
    multiDayCount: f.multi_day_count, durationHours: f.duration_hours == null ? null : Number(f.duration_hours),
    seasonStart: f.season_start, seasonEnd: f.season_end, nearestFreeDate: null, keepsSchedule: false,
    operatorSlug: null, operatorPublic: true, partnerVerified: null, linkKind: 'main_place',
  };
  const { container } = render(<PlaceTours tours={[t]} state="ok" day="2026-11-17" placeName="Тестовое место" />);
  return container;
}

async function apiTour(f: Fixture): Promise<Record<string, unknown>> {
  current = f;
  const res = await tourApi(new NextRequest(`https://vedarai.ru/api/tours/${f.id}`), { params: Promise.resolve({ id: String(f.id) }) });
  expect(res.status).toBe(200);
  const body = await res.json() as { data: Record<string, unknown> };
  return body.data;
}

async function apiAvailability(f: Fixture, from: string, to: string) {
  current = f;
  const res = await availabilityApi(
    new NextRequest(`https://vedarai.ru/api/tours/${f.id}/availability?startDate=${from}&endDate=${to}`),
    { params: Promise.resolve({ id: String(f.id) }) },
  );
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { availability: Array<{ date: string; available: boolean; reason?: string }>; season: string; maxGroupSize: number | null } };
  return body.data;
}

async function mcpDetails(f: Fixture): Promise<string> {
  current = f;
  return flat(await getTourDetails(String(f.id)));
}

async function mcpAvailability(f: Fixture, from: string, days: number): Promise<string> {
  current = f;
  return flat(await getTourAvailabilityForKuzmich({ tour: String(f.id), date_from: from, days: String(days) }));
}

/** Значение полосы фактов карточки под меткой. */
function strip(container: HTMLElement, label: string): string | null {
  const el = within(container).queryAllByText(label).find((e) => e.nextElementSibling);
  return el?.nextElementSibling?.textContent ?? null;
}

/** Текст секции карточки под заголовком. */
function section(container: HTMLElement, heading: string): string {
  const h = within(container).getAllByText(heading).find((e) => e.closest('section'));
  return flat(h?.closest('section')?.textContent);
}

/* ─── Сверка ─── */

describe('цена: одна строка, без «от», с единицей тура', () => {
  for (const f of FIXTURES) {
    it(`${f.title}`, async () => {
      const said = flat(priceWithUnitWords(f.base_price, f.price_unit));
      expect(said).not.toMatch(/(^|\s)от\s/);

      const card = renderCard(f);
      expect(flat(card.textContent)).toContain(flat(priceSum(f.base_price)));
      expect(flat(card.textContent)).toContain(priceUnitWords(f.price_unit));
      expect(flat(card.textContent)).not.toMatch(new RegExp(`от ${flat(priceSum(f.base_price))}`));
      cleanup();

      expect(flat(renderPlaceBlock(f).textContent)).toContain(said);
      expect(flat((await apiTour(f)).priceText as string)).toBe(said);

      const mcp = await mcpDetails(f);
      expect(mcp).toContain(`Цена: ${said}`);
      expect(mcp).not.toMatch(/от [\d ]+₽/);
    });
  }
});

describe('длительность: одна функция — часы, «1 день», «N дней»', () => {
  it('часы меньше суток — часами и на карточке, и у места, и в MCP', async () => {
    expect(cardDuration(UZON)).toBe('3 ч');
  });
  for (const f of FIXTURES) {
    it(`${f.title}`, async () => {
      const said = cardDuration(f);
      expect(said).not.toBeNull();
      const card = renderCard(f);
      expect(strip(card, 'Длится')).toBe(said);
      cleanup();
      expect(flat(renderPlaceBlock(f).textContent)).toContain(said as string);
      expect((await apiTour(f)).durationText).toBe(said);
      expect(await mcpDetails(f)).toContain(`Длительность: ${said}`);
    });
  }
});

describe('группа: из min/max_participants, без умолчания 20', () => {
  for (const f of FIXTURES) {
    it(`${f.title}`, async () => {
      const max = Number(f.max_participants);
      const min = f.min_participants == null ? null : Number(f.min_participants);

      const api = await apiTour(f);
      expect(api.maxGroupSize).toBe(max);
      expect(api.minGroupSize).toBe(min);
      expect((await apiAvailability(f, '2027-07-01', '2027-07-02')).maxGroupSize).toBe(max);

      const card = flat(renderCard(f).textContent);
      expect(card).toContain(min !== null ? `Группа: ${min}–${max} чел.` : `до ${max}`);
      expect(card).not.toMatch(/Группа: \d+–(null|undefined)/);
      cleanup();

      const mcp = await mcpDetails(f);
      expect(mcp).toMatch(new RegExp(`до ${max} чел\\.`));
      expect(mcp).not.toMatch(/до 20 чел/);
    });
  }

  it('описание спорит с записью — функция ловит, MCP называет, не выбирая число', async () => {
    const conflicts = groupClaimConflicts(PERVAL.description, PERVAL.min_participants, PERVAL.max_participants);
    expect(conflicts).toEqual([{ phrase: 'Группа от 4 человек', bound: 'min', said: 4, recorded: 1 }]);
    expect(await mcpDetails(PERVAL)).toContain(flat(groupClaimConflictLine(conflicts)));
    // Совпадает с записью — расхождения нет; оборот без «человек» — не о группе.
    expect(groupClaimConflicts('Группа до 8 человек, от 2 до 8 участников.', 2, 8)).toEqual([]);
    expect(groupClaimConflicts('Цена от 4 000 ₽, подъём до 8 часов.', 1, 8)).toEqual([]);
    expect(groupClaimConflicts('Группы от 2 до 6 человек.', 1, 8)).toEqual([
      { phrase: 'Группы от 2 до 6 человек', bound: 'min', said: 2, recorded: 1 },
      { phrase: 'Группы от 2 до 6 человек', bound: 'max', said: 6, recorded: 8 },
    ]);
    expect(groupClaimConflicts('до 10 человек в лодке', null, null)).toEqual([
      { phrase: 'до 10 человек', bound: 'max', said: 10, recorded: null },
    ]);
    expect(await mcpDetails(UZON)).not.toMatch(/Размер группы расходится/);
  });
});

describe('входит и не входит — разные секции, те же пункты, что в MCP', () => {
  for (const f of FIXTURES) {
    it(`${f.title}`, async () => {
      const card = renderCard(f);
      const inc = section(card, 'Входит в стоимость');
      const exc = section(card, 'Не входит в стоимость');
      for (const item of f.included) { expect(inc).toContain(item); expect(exc).not.toContain(item); }
      for (const item of f.not_included) { expect(exc).toContain(item); expect(inc).not.toContain(item); }
      expect(within(card).queryByText('Что включено')).toBeNull();
      cleanup();
      const mcp = await mcpDetails(f);
      expect(mcp).toContain(`Входит в стоимость: - ${f.included.join(' - ')}`);
      expect(mcp).toContain(`Не входит: - ${f.not_included.join(' - ')}`);
    });
  }
});

describe('программа: текст шага виден без нажатия и совпадает с MCP', () => {
  for (const f of FIXTURES) {
    it(`${f.title}`, async () => {
      const card = renderCard(f);
      const prog = section(card, 'Программа');
      const mcp = await mcpDetails(f);
      for (const step of f.program as Array<string | { title: string; text: string }>) {
        const title = typeof step === 'string' ? step : step.title;
        expect(prog).toContain(title);
        expect(mcp).toContain(title);
        if (typeof step !== 'string') {
          expect(prog).toContain(step.text);
          expect(mcp).toContain(step.text);
        }
      }
      expect(card.querySelector('[aria-expanded]')).toBeNull();
    });
  }
});

describe('сезон: записан — датами; не записан — так и сказано, с календарём или без', () => {
  for (const f of FIXTURES) {
    it(`${f.title}`, async () => {
      const said = tourSeasonWords(f, calendarRangeOf(f.cal?.first, f.cal?.last));
      expect(strip(renderCard(f), 'Сезон')).toBe(said);
      cleanup();
      expect((await apiTour(f)).seasonText).toBe(said);
      expect(await mcpDetails(f)).toContain(`Сезон: ${said}`);
    });
  }
  it('у тура с календарём названы даты календаря, а не «не записан» без слов', () => {
    expect(tourSeasonWords(PERVAL, calendarRangeOf(PERVAL.cal?.first, PERVAL.cal?.last)))
      .toBe('не записан; даты в календаре оператора: 5 дек 2026 — 20 мар 2027');
    expect(tourSeasonWords(NOSEASON, null)).toBe(SEASON_NOT_RECORDED);
  });
});

describe('даты: сезон 2027 не открывает ноябрь 2026 ни в API, ни в MCP', () => {
  it('API календаря: даты вне сезона закрыты с причиной', async () => {
    const out = await apiAvailability(UZON, '2026-11-20', '2026-11-22');
    expect(out.availability).toHaveLength(3);
    for (const d of out.availability) {
      expect(d.available, d.date).toBe(false);
      expect(d.reason).toMatch(/только по сезону/);
    }
    const inSeason = await apiAvailability(UZON, '2027-07-01', '2027-07-01');
    expect(inSeason.availability[0].available).toBe(true);
  });

  it('MCP: те же даты — вне сезона, свободными не названы', async () => {
    const mcp = await mcpAvailability(UZON, '2026-11-20', 3);
    expect(mcp).not.toMatch(/2[0-2]\.11[^:]*: свободно/);
    expect(mcp).toMatch(/по сезону/);
  });

  it('тур без сезона и расписания: MCP не подаёт дни как свободные даты сезона; API говорит теми же словами', async () => {
    const mcp = await mcpAvailability(NOSEASON, '2026-11-20', 3);
    expect(mcp).toContain(`сезон ${SEASON_NOT_RECORDED}`);
    expect(mcp).toMatch(/Это не свободные даты сезона/);
    expect(mcp).not.toMatch(/свободно для заявки|все даты свободны/);
    expect((await apiAvailability(NOSEASON, '2026-11-20', '2026-11-20')).season).toBe(SEASON_NOT_RECORDED);
  });
});

describe('отмена: слова оператора — из условий или из правил безопасности, без обещаний платформы', () => {
  it('условий нет, фраза о возврате в правилах безопасности — её видят карточка, форма заявки, API и MCP', async () => {
    const phrase = 'При отмене экскурсии из-за погоды деньги возвращаются в полном объёме.';
    const card = renderCard(UZON);
    const block = card.querySelector('[data-tour-cancellation]');
    expect(block?.getAttribute('data-tour-cancellation')).toBe('safety_notes');
    expect(flat(block?.textContent)).toContain(phrase);
    // Правило о погоде без слова о деньгах — не условие отмены.
    expect(flat(block?.textContent)).not.toContain('возможны задержки');
    // Форма заявки на той же карточке.
    const form = flat(card.querySelector('#booking')?.textContent ?? card.textContent);
    expect(form).toContain(SAFETY_NOTES_CANCELLATION_HEAD);
    expect(form).not.toMatch(/оператор не записал|вернём всю сумму/);
    cleanup();

    expect((await apiTour(UZON)).cancellationText).toContain(phrase);
    const mcp = await mcpDetails(UZON);
    expect(mcp).toContain(phrase);
    expect(mcp).not.toMatch(/НЕ ЗАПИСАНЫ\. Не называй сроков/);
  });

  it('условия записаны — одни и те же строки везде', async () => {
    const card = renderCard(PERVAL);
    const block = flat(card.querySelector('[data-tour-cancellation]')?.textContent);
    expect(block).toContain('Бесплатная отмена за 3 дня до тура.');
    expect(block).toContain('Позже удерживается 50%.');
    cleanup();
    expect((await apiTour(PERVAL)).cancellationText).toBe('Условия отмены оператора: Бесплатная отмена за 3 дня до тура. Позже удерживается 50%.');
    expect(await mcpDetails(PERVAL)).toContain('Бесплатная отмена за 3 дня до тура. Позже удерживается 50%.');
  });

  it('ничего не записано — блока нет, API null, MCP «не записаны», обещания вернуть всё нет', async () => {
    const card = renderCard(NOSEASON);
    expect(card.querySelector('[data-tour-cancellation]')).toBeNull();
    expect(flat(card.textContent)).not.toMatch(/вернём всю сумму/);
    cleanup();
    expect((await apiTour(NOSEASON)).cancellationText).toBeNull();
    expect(await mcpDetails(NOSEASON)).toMatch(/НЕ ЗАПИСАНЫ/);
  });
});
