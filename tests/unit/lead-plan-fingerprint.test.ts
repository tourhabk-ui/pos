/**
 * Дубль заявки с планом — по телефону, комментарию и отпечатку плана (аудит
 * планировщика 07.11, волна 2.4, H8). Правило — lib/leads/plan-fingerprint
 * и createLeadDetailed (lib/leads/create).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Подменённая база держит заявки и отвечает на поиск дубля по смыслу SQL:
 * телефон и комментарий, а с отпечатком — ещё и план. Что SQL именно такой,
 * держит отдельная проверка ниже; на настоящем PostgreSQL тот же запрос
 * проверен при сдаче (описание PR).
 */
type Row = { id: string; phone: string; comment: string | null; source_data: Record<string, unknown> | null };
const table: Row[] = [];
const dbCalls: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      dbCalls.push({ sql, params });
      if (/SELECT id FROM leads/.test(sql)) {
        const byPlan = /plan_fingerprint/.test(sql);
        const hit = table.find((r) => r.phone === params[0] && (byPlan
          ? (r.comment ?? '') === params[1] && r.source_data?.plan_fingerprint === params[2]
          : r.comment === params[1]));
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/INSERT INTO leads/.test(sql)) {
        const id = `lead-${table.length + 1}`;
        table.push({ id, phone: String(params[1]), comment: (params[2] as string | null) ?? null, source_data: params[6] ? JSON.parse(String(params[6])) : null });
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }),
  },
}));
vi.mock('@/lib/notifications/telegram-channel', () => ({ notifyAdminNewLead: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/crm/contacts', () => ({ linkContactQuietly: vi.fn().mockResolvedValue(undefined) }));

import { planFingerprint } from '@/lib/leads/plan-fingerprint';
import { createLeadDetailed } from '@/lib/leads/create';
import { planForLead, planLeadLines } from '@/lib/planner/plan-for-lead';

type Day = Parameters<typeof planForLead>[0][number];
const day = (n: number, title: string, extra: Partial<Day> = {}): Day => ({
  day: n, type: 'activity', zone: 'avachinsky', title, activityType: 'volcano', priceFrom: 0, priceTo: 0, ...extra,
} as Day);
const PROFILE = { adults: 2, children: [10, 6], budgetTier: 'comfort' as const, tripOrigin: 'visitor' as const, arrivalDate: '2030-08-01' };
const DAYS = [
  day(1, 'Прилёт', { type: 'arrival' }),
  day(2, 'Авачинский вулкан', { realPrice: 10000, realTour: { tourId: 't-1', priceUnit: 'per_person', maxParticipants: 10, lodgingIncluded: false } }),
  day(3, 'Сборы и вылет', { type: 'departure' }),
];
const plan = (days = DAYS, profile = PROFILE, needs?: Parameters<typeof planForLead>[3]) => planForLead(days, profile, undefined, needs);
const OTHER_PLAN = plan(DAYS.map((d) => (d.day === 2 ? { ...d, realTour: { ...d.realTour!, tourId: 't-9' } } : d)));

describe('отпечаток плана', () => {
  it('тот же план — тот же отпечаток; порядок детей и цена тура его не меняют', () => {
    const a = planFingerprint(plan());
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(planFingerprint(plan(DAYS, { ...PROFILE, children: [6, 10] }))).toBe(a);
    const pricier = DAYS.map((d) => (d.day === 2 ? { ...d, realPrice: 12000 } : d));
    expect(planFingerprint(plan(pricier))).toBe(a);
  });

  it('другой тур, другая дата, другой состав, другие просьбы — другой отпечаток', () => {
    const a = planFingerprint(plan());
    expect(planFingerprint(OTHER_PLAN)).not.toBe(a);
    expect(planFingerprint(plan(DAYS, { ...PROFILE, arrivalDate: '2030-08-02' }))).not.toBe(a);
    expect(planFingerprint(plan(DAYS, { ...PROFILE, adults: 3 }))).not.toBe(a);
    expect(planFingerprint(plan(DAYS, PROFILE, { lodging: true, transfer: false, car: true }))).not.toBe(a);
  });

  it('не план — нет отпечатка', () => {
    expect(planFingerprint(undefined)).toBeNull();
    expect(planFingerprint({ v: 2 })).toBeNull();
    expect(planFingerprint('план')).toBeNull();
  });

  it('неполный план от чужого клиента — нет отпечатка, а не падение', () => {
    const shell = { v: 1, estimate: {}, days: [] };
    expect(planFingerprint({ ...shell, party: { adults: 2 } })).toBeNull();
    expect(planFingerprint({ ...shell, party: 'двое' })).toBeNull();
    expect(planFingerprint({ ...shell, party: { adults: 2, children: [] }, days: [null] })).toBeNull();
    expect(planFingerprint({ ...shell, party: { adults: 2, children: [] }, lodging: 'да', needs: true })).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('дубль заявки', () => {
  beforeEach(() => { dbCalls.length = 0; table.length = 0; });
  const PHONE = '+70000000000';
  const COMMENT = 'Маршрут: Маршрут 2030-08-01 (3 дн.)';
  const lead = (comment: string | undefined, p: unknown = plan()) =>
    createLeadDetailed({ name: 'Тест', phone: PHONE, ...(comment !== undefined ? { comment } : {}), source_data: { plan: p, source: 'saved_trip' } });

  it('запрос с планом — телефон, комментарий и отпечаток', async () => {
    await lead(COMMENT);
    const dup = dbCalls.find((c) => /SELECT id FROM leads/.test(c.sql))!;
    expect(dup.sql).toMatch(/phone = \$1 AND COALESCE\(comment, ''\) = \$2/);
    expect(dup.sql).toMatch(/source_data->>'plan_fingerprint' = \$3/);
    expect(dup.params).toEqual([PHONE, COMMENT, planFingerprint(plan())]);
  });

  it('отпечаток пишется в заявку — следующая с тем же планом его найдёт', async () => {
    await lead(COMMENT);
    expect(table[0]!.source_data).toMatchObject({ plan_fingerprint: planFingerprint(plan()), source: 'saved_trip' });
  });

  it('тот же комментарий, другой план (H8) — новая заявка, оператор видит новый план', async () => {
    expect(await lead(COMMENT)).toEqual({ id: 'lead-1', created: true });
    expect(await lead(COMMENT, OTHER_PLAN)).toEqual({ id: 'lead-2', created: true });
  });

  it('тот же план, тот же комментарий — прежняя заявка, без второй', async () => {
    await lead(COMMENT);
    expect(await lead(COMMENT)).toEqual({ id: 'lead-1', created: false });
    expect(table).toHaveLength(1);
  });

  it('один план у заявок на разные туры (агент с plan_id) — две заявки, а не одна', async () => {
    await lead('[Заявка на бронь] Тур "Вулкан" (ID1), дата 2030-08-02');
    expect(await lead('[Заявка на бронь] Тур "Сплав" (ID2), дата 2030-08-03')).toEqual({ id: 'lead-2', created: true });
  });

  it('из планировщика без комментария — повтор того же плана ловится', async () => {
    await lead(undefined);
    expect(await lead(undefined)).toEqual({ id: 'lead-1', created: false });
    expect(await lead(undefined, OTHER_PLAN)).toEqual({ id: 'lead-2', created: true });
  });

  it('неполный план — заявка создаётся, дубль по прежнему правилу', async () => {
    const r = await createLeadDetailed({ name: 'Тест', phone: PHONE, comment: 'Хочу тур', source_data: { plan: { v: 1, party: { adults: 2 }, days: [], estimate: {} } } });
    expect(r).toEqual({ id: 'lead-1', created: true });
    const dup = dbCalls.find((c) => /SELECT id FROM leads/.test(c.sql))!;
    expect(dup.sql).not.toMatch(/plan_fingerprint/);
  });

  it('без плана — прежнее правило: телефон и комментарий', async () => {
    await createLeadDetailed({ name: 'Тест', phone: PHONE, comment: 'Хочу тур' });
    const dup = dbCalls.find((c) => /SELECT id FROM leads/.test(c.sql))!;
    expect(dup.sql).toMatch(/comment = \$2/);
    expect(dup.sql).not.toMatch(/plan_fingerprint/);
    expect(dup.params).toEqual([PHONE, 'Хочу тур']);
  });
});

describe('что ещё нужно — в заявке словами (H6)', () => {
  it('отмеченное — в строке группы; ничего не отмечено или не записано — строки нет', () => {
    expect(planLeadLines(plan(DAYS, PROFILE, { lodging: true, transfer: false, car: true }))[0])
      .toBe('Группа: 2 взр., дети 10, 6 лет · уровень «комфорт» · ещё нужно: жильё, машина напрокат');
    expect(planLeadLines(plan(DAYS, PROFILE, { lodging: false, transfer: false, car: false }))[0]).not.toMatch(/ещё нужно/);
    expect(planLeadLines(plan())[0]).not.toMatch(/ещё нужно/);
  });
});
