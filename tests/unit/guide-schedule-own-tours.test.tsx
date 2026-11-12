// @vitest-environment jsdom
/**
 * tests/unit/guide-schedule-own-tours.test.tsx
 *
 * Расписание гида видит брони его собственных туров (#3213). До 11.11
 * расписание знало только личный календарь и назначения оператора: гид,
 * которого оператор назначил на день его собственного тура, пересечения не
 * видел ни на сайте, ни в чате.
 *
 * Что держит — вызовом и рендером:
 *  - пересечение по дням: многодневная бронь, начатая до окна; разные дни —
 *    не пересечение; повторы названий не множатся;
 *  - чтение: третий список и пересечения; отказ его — исключение, роут
 *    отвечает 500 «не удалось загрузить», а не пустым днём (§4.0);
 *  - экран чата: строка «Свой тур» и «Пересечение», в Telegram без ПД;
 *  - экран на сайте: карточка «Свой тур» со ссылкой на бронь, предупреждение
 *    о пересечении словами, имени и телефона туриста нет.
 * Сам SQL — на настоящем PostgreSQL: tests/integration/guide-team.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) }));
vi.mock('@/lib/auth/middleware', () => ({ requireRole: vi.fn(async () => ({ userId: 'u-guide', role: 'guide' })) }));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: vi.fn(async () => 'g-1') }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...rest }, children),
}));

import { daysInWindow, findScheduleConflicts } from '@/lib/guides/schedule-conflicts';
import { readGuideSchedule } from '@/lib/guides/schedule-read';
import { SCHEDULE_SQL, TEAM_SQL } from '@/lib/guides/team-queries';
import { scheduleScreen } from '@/lib/guides/chat-role/screens';
import GuideSchedulePageClient from '@/app/hub/guide/schedule/_GuideSchedulePageClient';

const DAY = '2026-11-15';
const assignmentRow = { booking_id: '501', booking_date: DAY, end_date: null, tour_title: 'Авача с оператором', participants: 4, booking_status: 'confirmed' };
const ownRow = { booking_id: '77', booking_date: '2026-11-14', end_date: '2026-11-16', tour_title: 'Мой тур на Горелый', participants: 3, booking_status: 'new' };

function answer(own: unknown[] | Error) {
  h.query.mockImplementation(async (sql: string) => {
    if (sql === SCHEDULE_SQL.list) return { rows: [] };
    if (sql === TEAM_SQL.assignedInRange) return { rows: [assignmentRow] };
    if (sql === TEAM_SQL.ownToursInRange) {
      if (own instanceof Error) throw own;
      return { rows: own };
    }
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  });
}

beforeEach(() => { h.query.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('пересечение по дням', () => {
  it('многодневная бронь, начатая до окна, занимает дни окна до своего конца', () => {
    expect(daysInWindow({ date: '2026-11-14', endDate: '2026-11-16' }, '2026-11-15', '2026-11-20')).toEqual(['2026-11-15', '2026-11-16']);
    expect(daysInWindow({ date: '2026-11-14', endDate: null }, '2026-11-15', '2026-11-20')).toEqual([]);
    expect(daysInWindow({ date: '2026-11-18', endDate: '2026-11-17' }, '2026-11-15', '2026-11-20')).toEqual(['2026-11-18']);
    expect(daysInWindow({ date: '2026-12-30', endDate: '2027-01-02' }, '2026-12-01', '2027-01-31')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('назначение и свой тур в один день — пересечение; в разные дни — нет; названия не повторяются', () => {
    const assigned = [
      { date: '2026-11-15', endDate: null, tourTitle: 'Авача' },
      { date: '2026-11-15', endDate: null, tourTitle: 'Авача' },
      { date: '2026-11-18', endDate: null, tourTitle: 'Мутновский' },
    ];
    const own = [{ date: '2026-11-14', endDate: '2026-11-16', tourTitle: 'Горелый' }];
    expect(findScheduleConflicts(assigned, own, '2026-11-10', '2026-11-20')).toEqual([
      { date: '2026-11-15', assigned: ['Авача'], own: ['Горелый'] },
    ]);
    expect(findScheduleConflicts(assigned, [], '2026-11-10', '2026-11-20')).toEqual([]);
  });
});

describe('чтение расписания: третий список', () => {
  it('брони своих туров идут третьим списком, пересечение названо; гид спрашивается своим id и окном', async () => {
    answer([ownRow]);
    const s = await readGuideSchedule('g-1', DAY, DAY);
    expect(s.ownBookings).toEqual([{ bookingId: '77', date: '2026-11-14', endDate: '2026-11-16', tourTitle: 'Мой тур на Горелый', participants: 3, status: 'new' }]);
    expect(s.conflicts).toEqual([{ date: DAY, assigned: ['Авача с оператором'], own: ['Мой тур на Горелый'] }]);
    const call = h.query.mock.calls.find(([sql]) => sql === TEAM_SQL.ownToursInRange);
    expect(call?.[1]).toEqual(['g-1', DAY, DAY]);
  });

  it('брони своих туров не прочитались — чтение падает целиком, роут отвечает 500, а не свободным днём', async () => {
    answer(Object.assign(new Error('connection terminated'), { code: '08006' }));
    await expect(readGuideSchedule('g-1', DAY, DAY)).rejects.toThrow();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('@/app/api/guide/schedule/route');
    const res = await GET(new NextRequest(`http://x/api/guide/schedule?dateFrom=${DAY}&dateTo=${DAY}`));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Не удалось загрузить расписание/);
  });
});

describe('экран «Расписание» в чате', () => {
  const schedule = {
    schedule: [],
    assignments: [{ bookingId: '501', date: DAY, endDate: null, tourTitle: 'Авача с оператором', participants: 4, status: 'confirmed' }],
    ownBookings: [{ bookingId: '77', date: '2026-11-14', endDate: '2026-11-16', tourTitle: 'Мой тур на Горелый', participants: 3, status: 'new' }],
    conflicts: [{ date: DAY, assigned: ['Авача с оператором'], own: ['Мой тур на Горелый'] }],
  };

  it('свой тур — на первый день окна с отрезком дат; пересечение — словами; в Telegram без ПД', () => {
    const tg = scheduleScreen({ from: DAY, to: '2026-11-28', page: 0, channel: 'telegram', schedule, groups: null, siteBase: 'https://x' });
    expect(tg.text).toMatch(/15\.11[^\n]*\n[\s\S]*Свой тур: Мой тур на Горелый — 3 чел\., Новая — ждёт вашего ответа, 14\.11–16\.11/);
    expect(tg.text).toMatch(/Пересечение: оператор назначил вас на «Авача с оператором», а у вас бронь своего тура «Мой тур на Горелый»/);
    expect(tg.text).toMatch(/Оператор брони ваших туров не видит/);
    expect(tg.pd).toBe(false);
  });

  it('ничего нет — пустота называет и брони своих туров', () => {
    const empty = scheduleScreen({
      from: DAY, to: '2026-11-28', page: 0, channel: 'telegram', groups: null, siteBase: 'https://x',
      schedule: { schedule: [], assignments: [], ownBookings: [], conflicts: [] },
    });
    expect(empty.text).toContain('На эти дни записей календаря, назначений на брони и броней ваших туров нет.');
  });
});

describe('экран «Расписание» на сайте', () => {
  function serve(body: unknown, status = 200) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) }));
  }

  it('свой тур — карточкой со ссылкой на бронь; пересечение — предупреждением; контакта туриста нет', async () => {
    serve({
      success: true,
      data: {
        schedule: [],
        assignments: [{ bookingId: '501', date: DAY, endDate: null, tourTitle: 'Авача с оператором', participants: 4, status: 'confirmed' }],
        ownBookings: [{ bookingId: '77', date: '2026-11-14', endDate: '2026-11-16', tourTitle: 'Мой тур на Горелый', participants: 3, status: 'confirmed' }],
        conflicts: [{ date: DAY, assigned: ['Авача с оператором'], own: ['Мой тур на Горелый'] }],
      },
    });
    render(<GuideSchedulePageClient />);
    const card = await screen.findByRole('link', { name: /Мой тур на Горелый/ });
    expect(card.getAttribute('href')).toBe('/hub/guide/own#booking-77');
    expect(card.textContent).toMatch(/Свой тур/);
    expect(card.textContent).toMatch(/Подтверждена/);
    expect(card.textContent).toMatch(/14\.11\.2026–16\.11\.2026/);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Пересечение: в этот день назначение оператора и бронь вашего тура/);
    expect(alert.textContent).toMatch(/Оператор назначил вас на «Авача с оператором», а у вас бронь своего тура «Мой тур на Горелый»/);
    expect(document.body.textContent).not.toMatch(/\+7|tourist/);
  });

  it('есть только бронь своего тура — день не «пустой»', async () => {
    serve({ success: true, data: { schedule: [], assignments: [], ownBookings: [{ bookingId: '78', date: DAY, endDate: null, tourTitle: 'Мой тур', participants: 2, status: 'new' }], conflicts: [] } });
    render(<GuideSchedulePageClient />);
    await screen.findByRole('link', { name: /Мой тур/ });
    expect(screen.queryByText('На этот день пока пусто')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('расписание не загрузилось — «не знаем, что у вас на этот день», а не пусто', async () => {
    serve({ success: false, error: 'Не удалось загрузить расписание. Попробуйте обновить страницу.' }, 500);
    render(<GuideSchedulePageClient />);
    await waitFor(() => expect(screen.getByText(/мы не знаем, что у вас на этот день/)).toBeTruthy());
    expect(screen.queryByText('На этот день пока пусто')).toBeNull();
  });
});
