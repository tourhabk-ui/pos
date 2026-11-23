/**
 * Кабинет в чате MAX и Telegram: «как вы выезжаете» на экране дат тура
 * (#3476 шаг 4, слово владельца 17.11 «Сайт и чат»).
 *
 * Рендером экрана (строка режима, кнопки, дни «свободна для заявки» и «вне
 * сезона»), разбором кнопки и вызовом потока нажатия: запись — общей
 * единая дверь записи с владельцем, менеджер команды не пишет, отказ базы —
 * словами, а не «записал».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  write: vi.fn(),
  query: vi.fn(),
}));

// С 23.11 двери владельца пишут тур единой дверью (lib/tours/tour-change):
// содержание опубликованного тура идёт на проверку. Здесь судится, что дверь
// зовёт именно её и с владельцем; модерацию — tests/integration/tour-moderation.pg.test.ts.
vi.mock('@/lib/tours/tour-change', () => ({ saveTourChange: h.write }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []) },
}));
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: vi.fn() }));

const { datesScreen, scheduleKindLine } = await import('@/lib/guides/tour-edit/screens');
const { guideTourPress } = await import('@/lib/guides/tour-edit/flow');
const { cabinetPayload, parseCabinetPress } = await import('@/lib/chat-cabinet/payload');
const { isWritePayload } = await import('@/lib/chat-cabinet/signed-payload');
import type { ChatTour, TourDay } from '@/lib/guides/tour-edit/store';

const TOUR: ChatTour = {
  id: '77', title: 'Сплав по Быстрой', slug: null, isActive: true, isPublished: true,
  basePrice: 15000, priceUnit: 'per_person', maxParticipants: 8,
  scheduleKind: 'any_day', seasonStart: '2026-11-20', seasonEnd: '2026-11-30',
  fields: {} as ChatTour['fields'],
};
const day = (date: string, over: Partial<TourDay> = {}): TourDay => ({ date, slots: null, closed: false, taken: 0, ...over });
const payloads = (rows: ReadonlyArray<ReadonlyArray<{ payload?: string; text: string }>>) => rows.flat().map((b) => b.payload ?? '');
const texts = (rows: ReadonlyArray<ReadonlyArray<{ text: string }>>) => rows.flat().map((b) => b.text);

describe('экран дат: строка режима и кнопка', () => {
  it('любой день сезона: дни без строки — «свободна для заявки» с «Закрыть», вне сезона — без кнопки', () => {
    const s = datesScreen({ tour: TOUR, days: [day('2026-11-19'), day('2026-11-20'), day('2026-11-21', { closed: true, slots: 0 })], page: 0, back: 'calendar' });
    expect(s.text).toContain('Как вы выезжаете: в любой день сезона (20.11–30.11). Даты ниже — исключения');
    expect(s.text).toMatch(/19\.11 \S+ — вне сезона/);
    expect(s.text).toMatch(/20\.11 \S+ — свободна для заявки/);
    expect(s.text).toMatch(/21\.11 \S+ — закрыта/);
    const ps = payloads(s.rows);
    expect(ps).toContain(cabinetPayload.dateClose('77', '2026-11-20'));
    expect(ps).not.toContain(cabinetPayload.dateClose('77', '2026-11-19'));
    // Переключатель — только на другой режим.
    expect(texts(s.rows)).toContain('Только мои даты');
    expect(texts(s.rows)).not.toContain('Выезжаю в любой день сезона');
    expect(ps).toContain(cabinetPayload.scheduleKind('77', 'departures'));
  });

  it('только свои даты и «не указано» — свои строки и кнопки; день без строки — «не открыта»', () => {
    const dep = datesScreen({ tour: { ...TOUR, scheduleKind: 'departures' }, days: [day('2026-11-20')], page: 0 });
    expect(dep.text).toContain('Как вы выезжаете: только в свои даты');
    expect(dep.text).toMatch(/20\.11 \S+ — не открыта/);
    expect(texts(dep.rows)).toContain('Выезжаю в любой день сезона');
    expect(texts(dep.rows)).not.toContain('Только мои даты');

    const none = datesScreen({ tour: { ...TOUR, scheduleKind: null }, days: [day('2026-11-20')], page: 0 });
    expect(none.text).toContain('Как вы выезжаете: не указано — туристы видят «даты по запросу».');
    expect(texts(none.rows)).toEqual(expect.arrayContaining(['Выезжаю в любой день сезона', 'Только мои даты']));
  });

  it('любой день без сезона — сказано, что туристы этого не увидят', () => {
    expect(scheduleKindLine({ scheduleKind: 'any_day', seasonStart: null, seasonEnd: '2026-11-30' }))
      .toMatch(/сезон у тура не записан, и туристы этого не увидят/);
  });
});

describe('кнопка: разбор и подпись', () => {
  it('разбирается обратно в нажатие и считается кнопкой-записью (подписывается)', () => {
    expect(parseCabinetPress(cabinetPayload.scheduleKind('77', 'any_day'))).toEqual({ kind: 'schedule_kind', tourId: '77', scheduleKind: 'any_day' });
    expect(parseCabinetPress(cabinetPayload.scheduleKind('77', 'departures'))).toEqual({ kind: 'schedule_kind', tourId: '77', scheduleKind: 'departures' });
    expect(isWritePayload('cb:w:k:a:77')).toBe(true);
    expect(parseCabinetPress('cb:w:k:x:77')).toBeNull();
  });
});

describe('нажатие: запись и исходы', () => {
  const OPERATOR = {
    partnerId: '56565656-5656-4565-8565-565656565656', partnerName: 'Компания', slug: null,
    category: 'operator', crmCategory: 'operator' as const, userId: '34343434-3434-4343-8343-343434343434', sellsTours: undefined,
  };
  const who = (owner: boolean) => ({ partner: OPERATOR, owner, channel: 'telegram' as const, chatId: 1, nowMs: Date.UTC(2026, 10, 17) });
  const press = { kind: 'schedule_kind' as const, tourId: '77', scheduleKind: 'any_day' as const };
  const tourRow = {
    id: '77', title: 'Сплав по Быстрой', slug: null, is_active: true, is_published: true, base_price: 15000, price_unit: 'per_person',
    max_participants: 8, schedule_kind: 'any_day', season_start: '2026-11-20', season_end: '2026-11-30',
    short_description: null, description: null, program: null, included: null, not_included: null, what_to_bring: null, safety_notes: null,
  };

  beforeEach(() => {
    h.write.mockReset();
    h.query.mockReset();
    h.query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours t/.test(sql)) return { rows: [tourRow] };
      if (/generate_series/.test(sql)) return { rows: [{ date: '2026-11-20', slots: null, closed: false, taken: 0 }] };
      return { rows: [] };
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('владелец: пишет общей правкой тура с владельцем и показывает даты с исходом', async () => {
    h.write.mockResolvedValue({ outcome: 'written', row: { id: '77', title: 'Сплав по Быстрой', updated_at: '' } });
    const s = await guideTourPress(press, who(true));
    expect(h.write).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tourId: '77', ownerId: OPERATOR.partnerId, input: { schedule_kind: 'any_day' },
    }));
    expect(s.text).toContain('Записал: выезжаете в любой день сезона.');
    expect(s.text).toMatch(/свободна для заявки/);
  });

  it('менеджер команды — не пишет', async () => {
    const s = await guideTourPress(press, who(false));
    expect(h.write).not.toHaveBeenCalled();
    expect(s.text).toMatch(/только владелец карточки/);
  });

  it('не свой тур — «не найдено»; база не ответила — словами, без «записал»', async () => {
    h.write.mockResolvedValueOnce({ outcome: 'not_found' });
    const gone = await guideTourPress(press, who(true));
    expect(gone.text).not.toContain('Записал');

    h.write.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '57P01' }));
    const failed = await guideTourPress(press, who(true));
    expect(failed.text).toContain('Не записалось — база не ответила. Ничего не изменено.');
    expect(failed.failed).toBe(true);
  });
});
