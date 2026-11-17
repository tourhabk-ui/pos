/**
 * Кабинет оператора на сайте: «как вы выезжаете» и «закрыть день» (#3476
 * шаг 4, слово владельца 17.11 «Сайт и чат»).
 *
 * Рендером карточки тура (что видит оператор и что уходит в правку), вызовом
 * записи правки (колонка доходит до UPDATE) и вызовом роута расписания
 * (закрытые дни — в ответе, «не прочитались» — null, а не пустой список).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  getAvailability: vi.fn(async () => [] as unknown[]),
  loadClosedDays: vi.fn(async () => new Set<string>() as Set<string> | null),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: '51' }),
}));
vi.mock('@/lib/db/column-types', () => ({
  getColumnTypes: async () => new Map(),
  valueForColumn: (v: unknown) => v,
}));
vi.mock('@/lib/auth/middleware', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireOperator: async () => ({ userId: 'u1', role: 'admin' }),
}));
vi.mock('@/lib/api/operator-tours', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAvailability: h.getAvailability,
}));
vi.mock('@/lib/tours/closed-days', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadClosedDays: h.loadClosedDays,
}));

import EditTourClient from '@/app/hub/operator/tours/[id]/_EditTourClient';
import TourClosedDays from '@/components/operator/Tours/TourClosedDays';
import { UpdateTourSchema } from '@/lib/api/operator-tours';
import { writeTourPatch } from '@/lib/tours/tour-write';
import { GET as availabilityGET } from '@/app/api/hub/operator/tours/[id]/availability/route';

const TOUR = {
  id: '51', title: 'Сплав по Быстрой', short_description: null, description: null,
  location_type: 'river', activity_type: 'rafting', location_name: 'Быстрая',
  latitude: null, longitude: null, base_price: 15000, price_old: null, price_unit: 'per_person',
  max_participants: 10, min_participants: null, duration_hours: 8, duration_type: 'day', multi_day_count: null,
  season_start: '2099-06-01', season_end: '2099-09-30', seasonal_only: false, difficulty: null, weather_dependent: true,
  is_active: true, is_published: true, included: [], not_included: [], what_to_bring: [],
  cancellation_policy: null, pickup_type: null, pickup_details: null,
  photos: [], tour_image: null, program: null, safety_notes: null, video_clips: [],
  photo_credits: {}, on_storefront: true, schedule_kind: 'any_day',
};

let patchBodies: Array<Record<string, unknown>>;
let blockCalls: Array<{ method: string; body: Record<string, unknown> }>;

function mockFetch(tour: Record<string, unknown>, closed: string[] | null = []) {
  patchBodies = [];
  blockCalls = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/api/operator/calendar/block')) {
      blockCalls.push({ method: String(init?.method), body: JSON.parse(String(init?.body)) });
      return json({ success: true });
    }
    if (init?.method === 'PATCH') {
      patchBodies.push(JSON.parse(String(init.body)));
      return json({ success: true, data: { id: '51' } });
    }
    if (u.includes('/availability')) return json({ success: true, data: [], closed_days: closed });
    return json({ success: true, data: tour });
  }) as unknown as typeof fetch;
}

const save = async () => {
  fireEvent.click(screen.getAllByText('Сохранить')[0]);
  await waitFor(() => expect(patchBodies.length).toBe(1));
  return patchBodies[0];
};

beforeEach(() => vi.clearAllMocks());

describe('карточка тура: как вы выезжаете', () => {
  it('выбор из тура отмечен; сменили — уходит в правку; «Не указано» — null', async () => {
    mockFetch(TOUR);
    render(<EditTourClient />);
    const anyDay = await screen.findByRole('radio', { name: /В любой день сезона/ });
    await waitFor(() => expect((anyDay as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole('radio', { name: /Только в мои даты/ }));
    expect((await save()).schedule_kind).toBe('departures');

    patchBodies = [];
    fireEvent.click(screen.getByRole('radio', { name: /Не указано/ }));
    expect((await save()).schedule_kind).toBeNull();
  });

  it('«в любой день» без сезона — предупреждение словами; сезон есть — нет', async () => {
    mockFetch({ ...TOUR, season_start: null, season_end: null });
    render(<EditTourClient />);
    expect(await screen.findByText(/без них туристы не увидят «в любой день сезона»/)).toBeTruthy();
  });

  it('с сезоном предупреждения нет; неизвестное значение колонки читается как «не указано»', async () => {
    mockFetch({ ...TOUR, schedule_kind: 'weekly' });
    render(<EditTourClient />);
    const none = await screen.findByRole('radio', { name: /Не указано/ });
    await waitFor(() => expect((none as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByText(/без них туристы не увидят/)).toBeNull();
  });
});

describe('карточка тура: закрыть день', () => {
  it('закрытые дни видны с кнопкой «Открыть»; «Открыть» и «Закрыть» зовут роут календаря', async () => {
    mockFetch(TOUR, ['2099-08-07']);
    render(<EditTourClient />);
    const list = await screen.findByRole('list', { name: 'Закрытые дни' });
    expect(list.textContent).toMatch(/Закрыт:.*7/);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await waitFor(() => expect(blockCalls).toHaveLength(1));
    expect(blockCalls[0]).toEqual({ method: 'DELETE', body: { tourId: 51, startDate: '2099-08-07', endDate: '2099-08-07' } });

    fireEvent.change(screen.getByLabelText('Закрыть день'), { target: { value: '2099-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(blockCalls).toHaveLength(2));
    expect(blockCalls[1]).toEqual({ method: 'POST', body: { tourId: 51, startDate: '2099-08-10', endDate: '2099-08-10' } });
  });

  it('закрытые дни не прочитались — сказано, а не пустой список', async () => {
    mockFetch(TOUR, null);
    render(<EditTourClient />);
    expect(await screen.findByText('Закрытые дни не загрузились — обновите расписание.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Закрытые дни' })).toBeNull();
  });

  it('отказ роута — в строку ошибки карточки, список не перечитывается', async () => {
    const onError = vi.fn();
    const onChanged = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Тур не найден или нет прав' }), { status: 404 })) as unknown as typeof fetch;
    render(<TourClosedDays tourId="51" closed={[]} onChanged={onChanged} onError={onError} />);
    fireEvent.change(screen.getByLabelText('Закрыть день'), { target: { value: '2099-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Тур не найден или нет прав'));
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('сервер: правка и расписание', () => {
  it('схема правки принимает два значения и null, чужое отвергает', () => {
    expect(UpdateTourSchema.parse({ schedule_kind: 'any_day' })).toEqual({ schedule_kind: 'any_day' });
    expect(UpdateTourSchema.parse({ schedule_kind: null })).toEqual({ schedule_kind: null });
    expect(() => UpdateTourSchema.parse({ schedule_kind: 'weekly' })).toThrow();
  });

  it('колонка доходит до UPDATE тура', async () => {
    const sql: Array<[string, unknown[]]> = [];
    const client = { query: vi.fn(async (q: string, p: unknown[] = []) => { sql.push([q, p]); return { rows: [{ id: '51' }], rowCount: 1 }; }) };
    await writeTourPatch(client as never, { tourId: '51', ownerId: 'p1', input: { schedule_kind: 'any_day' }, current: {} });
    const update = sql.find(([q]) => /UPDATE operator_tours/.test(q));
    expect(update?.[0]).toMatch(/schedule_kind = \$1/);
    expect(update?.[1][0]).toBe('any_day');
  });

  it('расписание отдаёт закрытые дни по порядку; не прочитались — null', async () => {
    const req = () => new NextRequest('http://localhost/api/hub/operator/tours/51/availability?from=2099-06-01&to=2099-09-30');
    h.loadClosedDays.mockResolvedValueOnce(new Set(['2099-08-10', '2099-08-07']));
    const ok = await (await availabilityGET(req(), { params: Promise.resolve({ id: '51' }) })).json();
    expect(ok.closed_days).toEqual(['2099-08-07', '2099-08-10']);
    expect(h.loadClosedDays).toHaveBeenCalledWith('51', '2099-06-01', '2099-09-30');

    h.loadClosedDays.mockResolvedValueOnce(null);
    const failed = await (await availabilityGET(req(), { params: Promise.resolve({ id: '51' }) })).json();
    expect(failed.success).toBe(true);
    expect(failed.closed_days).toBeNull();
  });
});
