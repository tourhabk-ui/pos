/**
 * Модерация правок тура — правило, экраны, сообщение о решении и сторожа
 * (план готовности 23.11, этап 4).
 *
 * Механика на базе (черновик, одобрение, отказ, все двери владельца) судится
 * на настоящем PostgreSQL: tests/integration/tour-moderation.pg.test.ts.
 * Здесь — то, что видит человек, и то, чего в коде быть не должно:
 *  - правило деления правки на «через проверку» и «сразу»;
 *  - очередь администратора рендером: было / стало, превью снимков, фильтр,
 *    отпечаток карточки едет с одобрением;
 *  - статус тура у оператора и гида рендером; форма владельца публикацию не
 *    шлёт, «отправить на проверку» — шлёт просьбу;
 *  - сообщение владельцу о решении — вызовом с подменённым транспортом;
 *  - дверь решения администратора — вызовом;
 *  - запреты: мимо единой двери владелец в тур не пишет, черновик не читает
 *    никто, кроме названных файлов.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/hub/operator/tours',
  useParams: () => ({ id: '51' }),
}));
vi.mock('@/components/auth/Protected', () => ({ Protected: ({ children }: { children: React.ReactNode }) => children }));

const h = vi.hoisted(() => ({
  withdraw: vi.fn(),
  guidePartner: vi.fn(),
  decide: vi.fn(),
  notify: vi.fn(async () => undefined),
  ping: vi.fn(),
  reach: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'c4000000-0000-4000-8000-0000000002ad', role: 'admin' })),
  requireRole: vi.fn(async () => ({ userId: 'c4000000-0000-4000-8000-000000000301', role: 'guide' })),
}));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: h.guidePartner }));
vi.mock('@/lib/tours/moderation-review', async (orig) => ({
  ...(await orig<typeof import('@/lib/tours/moderation-review')>()),
  decideTourEdit: h.decide,
}));
vi.mock('@/lib/tours/moderation-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/tours/moderation-store')>()),
  withdrawTourEdit: h.withdraw,
}));
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: h.ping }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: h.reach }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: h.send }));

import {
  MODERATED_TOUR_COLUMNS, contentDiff, pendingNotice, sameTourValue, splitTourInput,
  mainPlaceIdsOf, tourCabinetPath, tourDayKey, tourEditChanges, tourModerationState, tourReviewMark,
} from '@/lib/tours/moderation';
import { LIVE_CONTENT_COLUMNS } from '@/lib/tours/moderation-store';
import { loadPlaceNames } from '@/lib/tours/moderation-read';
import { TOUR_PATCH_COLUMNS } from '@/lib/tours/tour-write';
import { TourEditQueue, type TourEditCard } from '@/components/admin/TourEditQueue';
import { TourModerationStatus, type TourModerationView } from '@/components/tours/TourModerationStatus';
import { OwnTourCard, OwnTourForm } from '@/components/guide/OwnToursManager';
import { ownTourReviewWords } from '@/lib/guides/own-tour-words';
import { afterSaveWords } from '@/lib/guides/tour-edit/screens';
import { editDecisionText, notifyPartnerEditDecision } from '@/lib/notifications/partner-edit-notify';
import ModerationClient from '@/app/hub/admin/moderation/_ModerationClient';
import EditTourClient from '@/app/hub/operator/tours/[id]/_EditTourClient';
import ToursManagementClient from '@/app/hub/operator/tours/_ToursManagementClient';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

// ─── Правило ──────────────────────────────────────────────────────────────────

describe('правило: что идёт через проверку, а что сразу', () => {
  it('содержание — через проверку; скрыть, число мест, расписание и вид активности — сразу', () => {
    const r = splitTourInput({
      title: 'Тур', base_price: 100, photos: ['/images/tours/a.jpg'], cancellation_policy: 'за 3 дня',
      is_active: false, max_participants: 6, schedule_kind: 'any_day', activity_type: 'trekking',
    });
    expect(Object.keys(r.content).sort()).toEqual(['base_price', 'cancellation_policy', 'photos', 'title']);
    expect(Object.keys(r.immediate).sort()).toEqual(['activity_type', 'is_active', 'max_participants', 'schedule_kind']);
    expect(r.wantsPublish).toBe(false);
  });

  it('сложность, длительность, место и сезон — через проверку (слово владельца 23.11)', () => {
    const named = {
      difficulty: 'hard',
      duration_hours: 8, duration_type: 'multi_day', multi_day_count: 3,
      location_name: 'Вулкан Горелый', location_type: 'volcano', latitude: 52.558, longitude: 158.03,
      season_start: '2027-06-01', season_end: '2027-09-30', seasonal_only: true,
    };
    const r = splitTourInput({ ...named, is_active: true });
    expect(Object.keys(r.content).sort()).toEqual(Object.keys(named).sort());
    expect(r.immediate).toEqual({ is_active: true });
    for (const col of Object.keys(named)) expect(MODERATED_TOUR_COLUMNS as readonly string[], col).toContain(col);
  });

  it('«опубликовать» — просьба, а не поле; «снять с публикации» — сразу', () => {
    const ask = splitTourInput({ is_published: true });
    expect(ask).toEqual({ content: {}, immediate: {}, wantsPublish: true });
    const off = splitTourInput({ is_published: false });
    expect(off).toEqual({ content: {}, immediate: { is_published: false }, wantsPublish: false });
  });

  it('каждое поле с проверкой — настоящая колонка записи тура', () => {
    // Главное место пишется своей веткой записи тура (перемена, источник, «место живое»),
    // а не общим списком колонок: что одобрение его применяет, судит pg-тест.
    const known = new Set<string>([...(TOUR_PATCH_COLUMNS as readonly string[]), 'main_place_id']);
    for (const col of MODERATED_TOUR_COLUMNS) expect(known.has(col), col).toBe(true);
    // Названные планом поля — в списке: тексты, цена и единица, снимки, состав, условия отмены, точка сбора.
    for (const col of ['title', 'description', 'program', 'base_price', 'price_unit', 'photos', 'tour_image',
      'included', 'not_included', 'cancellation_policy', 'pickup_details']) {
      expect(MODERATED_TOUR_COLUMNS as readonly string[], col).toContain(col);
    }
    // Публикация и показ в этот список не входят: одно — просьба, другое — сразу.
    expect(MODERATED_TOUR_COLUMNS as readonly string[]).not.toContain('is_published');
    expect(MODERATED_TOUR_COLUMNS as readonly string[]).not.toContain('is_active');
    // Закрыть выезд владелец обязан мочь сам: места, расписание и даты — не содержание.
    for (const col of ['max_participants', 'min_participants', 'schedule_kind', 'available_slots', 'next_available_date']) {
      expect(MODERATED_TOUR_COLUMNS as readonly string[], col).not.toContain(col);
    }
  });

  it('форма шлёт себя целиком: то же значение в другом виде — не правка', () => {
    expect(sameTourValue('base_price', '15000.00', 15000)).toBe(true);
    expect(sameTourValue('base_price', '15000.00', 15001)).toBe(false);
    expect(sameTourValue('description', null, '')).toBe(true);
    expect(sameTourValue('included', null, [])).toBe(true);
    expect(sameTourValue('program', [{ title: 'А', text: 'Б' }], [{ text: 'Б', title: 'А' }])).toBe(true);
    expect(contentDiff({ title: 'Тур', base_price: '100.00', included: null }, { title: 'Тур', base_price: 100, included: [] })).toEqual({});
    expect(contentDiff({ title: 'Тур', base_price: '100.00' }, { title: 'Тур', base_price: 120 })).toEqual({ base_price: 120 });
  });

  it('числа, даты и отметка: другая запись того же значения — не правка, другое значение — правка', () => {
    // Число: из базы numeric строкой, из формы — числом.
    expect(sameTourValue('duration_hours', '8.00', 8)).toBe(true);
    expect(sameTourValue('duration_hours', '8.00', 8.5)).toBe(false);
    expect(sameTourValue('multi_day_count', 3, '3')).toBe(true);
    expect(sameTourValue('latitude', '53.020000', 53.02)).toBe(true);
    expect(sameTourValue('longitude', '158.650000', 158.66)).toBe(false);
    // День календаря: строка базы, отметка времени из JSON, объект времени драйвера.
    expect(sameTourValue('season_start', '2027-06-01', '2027-06-01T00:00:00.000Z')).toBe(true);
    expect(sameTourValue('season_start', new Date(2027, 5, 1), '2027-06-01')).toBe(true);
    expect(sameTourValue('season_start', new Date(2027, 5, 1), '2027-06-02')).toBe(false);
    expect(sameTourValue('season_end', null, '')).toBe(true);
    expect(sameTourValue('season_end', null, '2027-09-30')).toBe(false);
    // Отметка: «не записано» и «нет» — одно.
    expect(sameTourValue('seasonal_only', null, false)).toBe(true);
    expect(sameTourValue('seasonal_only', undefined, false)).toBe(true);
    expect(sameTourValue('seasonal_only', false, true)).toBe(false);
    expect(sameTourValue('seasonal_only', null, true)).toBe(false);
    // Незаписанный вид длительности — не «однодневный».
    expect(sameTourValue('duration_type', null, 'day')).toBe(false);

    // Форма целиком на строке из базы: ни одного поля в черновик.
    const live = {
      difficulty: 'hard', duration_hours: '8.00', duration_type: 'day', multi_day_count: null,
      location_name: 'Вулкан Горелый', location_type: 'volcano', latitude: '52.558000', longitude: '158.030000',
      season_start: '2027-06-01', season_end: null, seasonal_only: null,
    };
    const form = {
      difficulty: 'hard', duration_hours: 8, duration_type: 'day', multi_day_count: null,
      location_name: 'Вулкан Горелый', location_type: 'volcano', latitude: 52.558, longitude: 158.03,
      season_start: '2027-06-01', season_end: null, seasonal_only: false,
    };
    expect(contentDiff(live, form)).toEqual({});
    expect(contentDiff(live, { ...form, season_end: '2027-09-30', difficulty: 'medium' }))
      .toEqual({ season_end: '2027-09-30', difficulty: 'medium' });
  });

  it('день календаря: местные год, месяц и число объекта времени; мусор — не день', () => {
    expect(tourDayKey('2027-06-01')).toBe('2027-06-01');
    expect(tourDayKey(' 2027-06-01T12:30:00+12:00 ')).toBe('2027-06-01');
    expect(tourDayKey(new Date(2027, 0, 1))).toBe('2027-01-01');
    expect(tourDayKey(new Date(2027, 11, 31, 23, 59))).toBe('2027-12-31');
    expect(tourDayKey(new Date('чепуха'))).toBeNull();
    expect(tourDayKey('июнь')).toBeNull();
    expect(tourDayKey(20270601)).toBeNull();
    expect(tourDayKey(null)).toBeNull();
  });

  it('главное место — через проверку; в диффе оно названо именем, а не адресом записи', () => {
    expect(splitTourInput({ main_place_id: 'place-a', is_active: true })).toEqual({
      content: { main_place_id: 'place-a' }, immediate: { is_active: true }, wantsPublish: false,
    });
    expect(MODERATED_TOUR_COLUMNS as readonly string[]).toContain('main_place_id');
    // Форма шлёт место при каждом сохранении: то же место — не правка, снятое — правка.
    expect(contentDiff({ main_place_id: 'place-a' }, { main_place_id: 'place-a' })).toEqual({});
    expect(contentDiff({ main_place_id: null }, { main_place_id: null })).toEqual({});
    expect(contentDiff({ main_place_id: 'place-a' }, { main_place_id: null })).toEqual({ main_place_id: null });

    const names = new Map([['place-a', 'Вулкан Горелый'], ['place-b', 'Вулкан Мутновский']]);
    const named = tourEditChanges({ main_place_id: 'place-a' }, { main_place_id: 'place-b' }, { placeNames: names });
    expect(named.map((c) => [c.label, c.before, c.after])).toEqual([['Главное место', 'Вулкан Горелый', 'Вулкан Мутновский']]);
    // Место сняли — «не записано»; места в справочнике нет — так и сказано, с адресом записи.
    expect(tourEditChanges({ main_place_id: 'place-a' }, { main_place_id: null }, { placeNames: names })[0].after).toBe('не записано');
    expect(tourEditChanges({ main_place_id: null }, { main_place_id: 'place-x' }, { placeNames: names })[0].after)
      .toBe('место не найдено в справочнике (place-x)');
    // Имена не прочитались — это не «места нет».
    for (const ctx of [{ placeNames: null }, {}, undefined]) {
      expect(tourEditChanges({ main_place_id: null }, { main_place_id: 'place-a' }, ctx)[0].after)
        .toBe('место place-a (название не прочитано)');
    }
  });

  it('адреса мест для чтения имён: из строк и правок, без пустых и повторов', () => {
    expect(mainPlaceIdsOf({ main_place_id: 'a' }, { main_place_id: 'b' }, { main_place_id: 'a' }, { main_place_id: null }, {}, null, undefined, { main_place_id: ' ' }, { main_place_id: 7 }))
      .toEqual(['a', 'b']);
    expect(mainPlaceIdsOf()).toEqual([]);
  });

  it('имена мест: сбой чтения — «не прочитано» (null), а не «мест нет»; без адресов база не спрашивается', async () => {
    const asked: unknown[][] = [];
    const answers = { query: async (_sql: string, params: unknown[]) => { asked.push(params); return { rows: [{ id: 'place-a', name: 'Вулкан Горелый' }] }; } };
    expect(await loadPlaceNames([], answers as never)).toEqual(new Map());
    expect(asked).toHaveLength(0);
    expect(await loadPlaceNames(['place-a', 'place-x'], answers as never)).toEqual(new Map([['place-a', 'Вулкан Горелый']]));
    expect(asked).toEqual([[['place-a', 'place-x']]]);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { query: async () => { throw Object.assign(new Error('нет связи'), { code: '08006' }); } };
    const names = await loadPlaceNames(['place-a'], broken as never);
    expect(names).toBeNull();
    // Отказ не глушится: имя проверки и SQLSTATE — в лог.
    expect(errors).toHaveBeenCalledWith('[tour-edit] имена мест не прочитаны, SQLSTATE', '08006');
    errors.mockRestore();
    // И дифф говорит об этом словами, а не выдаёт место за ненайденное.
    expect(tourEditChanges({ main_place_id: null }, { main_place_id: 'place-a' }, { placeNames: names })[0].after)
      .toBe('место place-a (название не прочитано)');
  });

  it('день календаря не съезжает на сутки в поясе Камчатки (UTC+12)', () => {
    // Драйвер собирает дату полночью по местному времени. В поясе восточнее
    // Гринвича строка UTC такой полуночи — ещё вчерашний день.
    const before = process.env.TZ;
    process.env.TZ = 'Asia/Kamchatka';
    try {
      const midnight = new Date(2027, 5, 1);
      // Пояс применился: иначе проверка ниже ничего бы не проверила.
      expect(midnight.getTimezoneOffset()).toBe(-720);
      expect(midnight.toISOString().slice(0, 10)).toBe('2027-05-31');
      expect(tourDayKey(midnight)).toBe('2027-06-01');
      expect(sameTourValue('season_start', midnight, '2027-06-01')).toBe(true);
      expect(tourEditChanges({ season_start: midnight }, { season_start: '2027-06-02' })[0].before).toBe('1 июня 2027 г.');
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });

  it('было и стало словами: сложность, длительность, сезон и место — не ключи базы и не рубли', () => {
    const changes = tourEditChanges(
      {
        difficulty: 'easy', duration_hours: '8.00', duration_type: 'day', multi_day_count: null,
        location_name: 'Вулкан Горелый', location_type: 'volcano', latitude: '52.558000', longitude: null,
        season_start: new Date(2027, 5, 1), season_end: '2027-09-30', seasonal_only: null, base_price: '10000.00',
      },
      {
        difficulty: 'hard', duration_hours: 30, duration_type: 'multi_day', multi_day_count: 3,
        location_name: 'Вулкан Мутновский', location_type: 'hot_spring', latitude: 52.4531, longitude: 158.195,
        season_start: '2027-07-15', season_end: null, seasonal_only: true, base_price: 12000,
      },
    );
    const by = Object.fromEntries(changes.map((c) => [c.field, c]));
    expect([by.difficulty.label, by.difficulty.before, by.difficulty.after]).toEqual(['Сложность', 'Лёгкий', 'Сложный']);
    expect([by.duration_hours.before, by.duration_hours.after]).toEqual(['8', '30']);
    expect([by.duration_type.before, by.duration_type.after]).toEqual(['однодневный', 'многодневный']);
    expect([by.multi_day_count.before, by.multi_day_count.after]).toEqual(['не записано', '3']);
    expect([by.location_name.label, by.location_name.after]).toEqual(['Место', 'Вулкан Мутновский']);
    expect([by.location_type.before, by.location_type.after]).toEqual(['Вулкан', 'Термальный источник']);
    expect([by.latitude.before, by.latitude.after]).toEqual(['52,558', '52,4531']);
    expect([by.longitude.before, by.longitude.after]).toEqual(['не записано', '158,195']);
    expect([by.season_start.before, by.season_start.after]).toEqual(['1 июня 2027 г.', '15 июля 2027 г.']);
    expect([by.season_end.before, by.season_end.after]).toEqual(['30 сентября 2027 г.', 'не записано']);
    expect([by.seasonal_only.label, by.seasonal_only.before, by.seasonal_only.after]).toEqual(['Только в сезон', 'нет', 'да']);
    // Рубль — только у цены.
    // Разделитель тысяч у ru-RU — неразрывный пробел.
    expect(by.base_price.after.replace(/[\u00a0\u202f]/g, ' ')).toBe('12 000 ₽');
    for (const c of changes) if (c.field !== 'base_price') expect(`${c.before}${c.after}`, c.field).not.toContain('₽');
    // Незнакомое написание не прячется: видно как записано.
    expect(tourEditChanges({}, { difficulty: 'лютый', duration_type: 'half_day', location_type: 'crater' }).map((c) => c.after))
      .toEqual(['лютый', 'half_day', 'crater']);
  });

  it('живая строка: даты читаются текстом, остальные колонки — как есть', () => {
    const cols = LIVE_CONTENT_COLUMNS.split(', ');
    expect(cols).toContain('ot.season_start::text AS season_start');
    expect(cols).toContain('ot.season_end::text AS season_end');
    expect(cols).toContain('ot.difficulty');
    expect(cols).toContain('ot.duration_hours');
    expect(cols.filter((c) => c.includes('::'))).toHaveLength(2);
    expect(cols).toHaveLength(MODERATED_TOUR_COLUMNS.length);
  });

  it('состояние и слова владельцу', () => {
    expect(tourModerationState({ published: false, pending: false, rejected: false })).toBe('draft');
    expect(tourModerationState({ published: true, pending: false, rejected: false })).toBe('live');
    expect(tourModerationState({ published: true, pending: true, rejected: true })).toBe('pending');
    expect(tourModerationState({ published: true, pending: false, rejected: true })).toBe('rejected');
    expect(pendingNotice(['base_price', 'photos'], false, true)).toBe('Правка отправлена на проверку (цена, фото). На витрине пока прежняя версия.');
    expect(pendingNotice([], true, false)).toBe('Тур отправлен на проверку. Туристы увидят его после одобрения администратором.');
    expect(tourCabinetPath('guide')).toBe('/hub/guide/own');
    expect(tourCabinetPath('operator')).toBe('/hub/operator/tours');
  });
});

// ─── Очередь администратора ───────────────────────────────────────────────────

const EDIT: TourEditCard = {
  id: 'e1000000-0000-4000-8000-000000000001', tourId: '51', tourTitle: 'Вулкан Горелый',
  partnerId: 'p1', partnerName: 'Камчатская рыбалка', partnerCategory: 'operator', kind: 'edit',
  changes: tourEditChanges(
    { base_price: '10000.00', photos: ['/images/tours/a.jpg'] },
    { base_price: 12000, photos: ['/images/tours/b.jpg', '/images/tours/c.jpg'] },
  ),
  content: [], seen: 'a'.repeat(64), since: '2026-11-23T10:00:00.000Z',
};
const NEW_TOUR: TourEditCard = {
  id: 'e1000000-0000-4000-8000-000000000002', tourId: '52', tourTitle: 'Новый сплав',
  partnerId: 'p2', partnerName: 'Гид Тест', partnerCategory: 'guide', kind: 'publish',
  changes: [],
  content: [
    { field: 'title', label: 'Название', text: 'Новый сплав' },
    { field: 'base_price', label: 'Цена', text: '8 000 ₽' },
    { field: 'photos', label: 'Фото', text: 'снимков: 1', photos: ['/images/tours/n.jpg'] },
  ],
  seen: 'b'.repeat(64), since: '2026-11-23T11:00:00.000Z',
};

function queue(over: Partial<React.ComponentProps<typeof TourEditQueue>> = {}) {
  const props = {
    loading: false, error: '', edits: [EDIT, NEW_TOUR], actingId: null, actionError: '',
    onRetry: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), ...over,
  };
  render(<TourEditQueue {...props} />);
  return props;
}

describe('очередь администратора: что видно', () => {
  it('правка тура на сайте — было и стало по полям, снимки превью, ссылка на живую карточку', () => {
    queue();
    const card = within(screen.getByRole('article', { name: 'Правка тура: Вулкан Горелый' }));
    expect(card.getByText('Правка тура на сайте')).toBeTruthy();
    expect(card.getByText('Туроператор: Камчатская рыбалка')).toBeTruthy();
    const changes = card.getAllByTestId('tour-edit-change');
    expect(changes.map((c) => within(c).getByRole('term').textContent)).toEqual(['Цена', 'Фото']);
    const price = (changes[0].textContent ?? '').replace(/[  ]/g, ' ');
    expect(price).toContain('На сайте сейчас10 000 ₽');
    expect(price).toContain('Станет12 000 ₽');
    // Снимки — картинками: что уйдёт с сайта и что придёт.
    const before = within(changes[1]).getByRole('list', { name: 'Фото: сейчас' });
    const after = within(changes[1]).getByRole('list', { name: 'Фото: станет' });
    expect(within(before).getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual(['/images/tours/a.jpg']);
    expect(within(after).getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual(['/images/tours/b.jpg', '/images/tours/c.jpg']);
    expect(card.getByRole('link', { name: 'как на сайте сейчас' }).getAttribute('href')).toBe('/catalog/tours/51');
    expect(card.getByRole('button', { name: 'Одобрить' })).toBeTruthy();
  });

  it('новый тур — всё содержание, которое выйдет на сайт; ссылки на сайт нет: его там ещё нет', () => {
    queue();
    const card = within(screen.getByRole('article', { name: 'Новый тур: Новый сплав' }));
    expect(card.getByText('Новый тур просится на сайт')).toBeTruthy();
    expect(card.getByText('Гид: Гид Тест')).toBeTruthy();
    expect(card.getAllByRole('term').map((t) => t.textContent)).toEqual(['Название', 'Цена', 'Фото']);
    expect(card.getByRole('img').getAttribute('src')).toBe('/images/tours/n.jpg');
    expect(card.queryByRole('link', { name: 'как на сайте сейчас' })).toBeNull();
    expect(card.getByRole('button', { name: 'Опубликовать' })).toBeTruthy();
  });

  it('правка без отличий от сайта — сказано словами, а не пустой карточкой', () => {
    queue({ edits: [{ ...EDIT, changes: [] }] });
    const card = within(screen.getByRole('article', { name: 'Правка тура: Вулкан Горелый' }));
    expect(card.getByText('Отличий от сайта нет: тур уже опубликован. Одобрение закроет запись, на сайте ничего не изменится.')).toBeTruthy();
    expect(card.queryAllByTestId('tour-edit-change')).toHaveLength(0);
  });

  it('отклонить нельзя без причины; причина уходит обрезанной; одобрение — по id карточки', () => {
    const props = queue();
    const card = within(screen.getByRole('article', { name: 'Правка тура: Вулкан Горелый' }));
    const reject = card.getByRole('button', { name: 'Отклонить' });
    expect(reject).toHaveProperty('disabled', true);
    fireEvent.change(card.getByLabelText('Причина отказа'), { target: { value: '  нет ' } });
    expect(reject).toHaveProperty('disabled', true);
    fireEvent.change(card.getByLabelText('Причина отказа'), { target: { value: '  Цена не сходится с программой ' } });
    fireEvent.click(reject);
    expect(props.onReject).toHaveBeenCalledWith(EDIT.id, 'Цена не сходится с программой');
    fireEvent.click(card.getByRole('button', { name: 'Одобрить' }));
    expect(props.onApprove).toHaveBeenCalledWith(EDIT.id);
  });

  it('фильтр: новые туры и правки — отдельно, со счётом', () => {
    queue();
    expect(screen.getAllByTestId('tour-edit')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Новые туры: 1' }));
    expect(screen.getAllByTestId('tour-edit').map((a) => a.getAttribute('aria-label'))).toEqual(['Новый тур: Новый сплав']);
    fireEvent.click(screen.getByRole('button', { name: 'Правки: 1' }));
    expect(screen.getAllByTestId('tour-edit').map((a) => a.getAttribute('aria-label'))).toEqual(['Правка тура: Вулкан Горелый']);
    fireEvent.click(screen.getByRole('button', { name: 'Все: 2' }));
    expect(screen.getAllByTestId('tour-edit')).toHaveLength(2);
  });

  it('три исхода чтения: пусто — «нет»; отказ — «не смог» и «Повторить»; загрузка — без карточек', () => {
    queue({ edits: [] });
    expect(screen.getByText('Туров и правок на проверке нет.')).toBeTruthy();
    cleanup();
    const props = queue({ edits: [], error: 'HTTP 503' });
    expect(screen.getByText(/Не смог загрузить правки туров\. HTTP 503/)).toBeTruthy();
    expect(screen.queryByText('Туров и правок на проверке нет.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(props.onRetry).toHaveBeenCalled();
    cleanup();
    queue({ loading: true });
    expect(screen.queryAllByTestId('tour-edit')).toHaveLength(0);
  });
});

describe('экран модерации: решение по туру', () => {
  function serve(decision: { status: number; body: unknown }) {
    const posts: Array<{ url: string; body: unknown }> = [];
    let listed = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes('/api/admin/content/reviews')) return json({ success: true, data: { reviews: [] } });
      if (url.includes('/api/admin/moderation/tour-edits/') && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json(decision.body, decision.status);
      }
      if (url.includes('/api/admin/moderation/tour-edits')) {
        listed += 1;
        return json({ success: true, data: { edits: [listed === 1 ? EDIT : { ...EDIT, seen: 'c'.repeat(64) }] } });
      }
      return json({ success: true, data: { edits: [] } });
    }));
    return { posts, listed: () => listed };
  }

  it('одобрение несёт отпечаток показанной карточки; карточка уходит из очереди', async () => {
    const { posts } = serve({ status: 200, body: { success: true } });
    render(<ModerationClient />);
    const card = within(await screen.findByRole('article', { name: 'Правка тура: Вулкан Горелый' }));
    fireEvent.click(card.getByRole('button', { name: 'Одобрить' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain(`/api/admin/moderation/tour-edits/${EDIT.id}`);
    expect(posts[0].body).toEqual({ action: 'approve', seen: 'a'.repeat(64) });
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Правка тура: Вулкан Горелый' })).toBeNull());
  });

  it('владелец дописал правку, пока карточка была открыта — причина видна, очередь перечитана', async () => {
    const { listed } = serve({ status: 409, body: { success: false, code: 'changed', error: 'Владелец изменил правку, пока карточка была открыта. Тур не изменён — проверьте новую правку.' } });
    render(<ModerationClient />);
    const card = within(await screen.findByRole('article', { name: 'Правка тура: Вулкан Горелый' }));
    fireEvent.click(card.getByRole('button', { name: 'Одобрить' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Тур не изменён');
    await waitFor(() => expect(listed()).toBe(2));
    // Карточка осталась: решения нет.
    expect(screen.getByRole('article', { name: 'Правка тура: Вулкан Горелый' })).toBeTruthy();
  });
});

// ─── Статус тура у владельца ──────────────────────────────────────────────────

const LIVE: TourModerationView = { state: 'live', published: true, pending: null, rejected: null };

function status(moderation: TourModerationView) {
  const handlers = { onAskPublish: vi.fn(), onUnpublish: vi.fn(), onWithdraw: vi.fn() };
  render(<TourModerationStatus moderation={moderation} busy={false} {...handlers} />);
  return handlers;
}

describe('статус тура у владельца', () => {
  it('черновик: туристы не видят; кнопка — просьба о проверке, а не «опубликовать»', () => {
    const hnd = status({ state: 'draft', published: false, pending: null, rejected: null });
    const box = screen.getByTestId('tour-moderation');
    expect(box.getAttribute('data-state')).toBe('draft');
    expect(box.textContent).toContain('Туристы тур не видят. На сайт он выйдет после проверки администратором.');
    expect(screen.queryByRole('button', { name: /Опубликовать/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Сохранить и отправить на проверку/ }));
    expect(hnd.onAskPublish).toHaveBeenCalledTimes(1);
  });

  it('правка на проверке: на сайте прежняя версия, дифф виден, можно отозвать', () => {
    const hnd = status({
      state: 'pending', published: true, rejected: null,
      pending: { changes: EDIT.changes, wantsPublish: false, since: '2026-11-23T10:00:00.000Z' },
    });
    const box = screen.getByTestId('tour-moderation');
    expect(box.textContent).toContain('Правка на проверке');
    expect(box.textContent).toContain('На сайте пока прежняя версия. Новая выйдет после одобрения администратором.');
    expect(within(box).getAllByTestId('tour-edit-change')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Отозвать правку' }));
    expect(hnd.onWithdraw).toHaveBeenCalledTimes(1);
  });

  it('тур на проверке: туристы увидят после одобрения', () => {
    status({ state: 'pending', published: false, rejected: null, pending: { changes: [], wantsPublish: true, since: '' } });
    const box = screen.getByTestId('tour-moderation');
    expect(box.textContent).toContain('Тур на проверке');
    expect(box.textContent).toContain('Туристы увидят тур после одобрения администратором.');
    expect(screen.getByRole('button', { name: 'Отозвать с проверки' })).toBeTruthy();
  });

  it('на сайте: сказано, что идёт через проверку, а что сразу; снять с публикации можно', () => {
    const hnd = status(LIVE);
    const box = screen.getByTestId('tour-moderation');
    const said = (box.textContent ?? '').replace(/\s+/g, ' ');
    expect(said).toContain('Правки названия, текстов, цены, условий, снимков, сложности, длительности, места и сезона выходят на сайт после проверки администратором.');
    expect(said).toContain('Скрыть тур, даты и число мест можно менять сразу.');
    // Сезон и сложность «сразу» больше не обещаны.
    expect(said).not.toMatch(/сезон[а-я]* (можно|меня)/);
    fireEvent.click(screen.getByRole('button', { name: 'Снять с публикации' }));
    expect(hnd.onUnpublish).toHaveBeenCalledTimes(1);
  });

  it('отказ: причина администратора показана как есть; пустая — так и сказано', () => {
    status({ state: 'rejected', published: true, pending: null, rejected: { reason: 'Цена <ниже> себестоимости', fields: ['base_price'], wantsPublish: false, at: null } });
    expect(screen.getByTestId('tour-moderation').textContent).toContain('Причина: Цена <ниже> себестоимости');
    expect(screen.getByTestId('tour-moderation').textContent).toContain('На сайте прежняя версия.');
    cleanup();
    status({ state: 'rejected', published: false, pending: null, rejected: { reason: null, fields: [], wantsPublish: true, at: null } });
    expect(screen.getByTestId('tour-moderation').textContent).toContain('Тур возвращён на доработку');
    expect(screen.getByTestId('tour-moderation').textContent).toContain('Причина не записана.');
    expect(screen.getByRole('button', { name: /Сохранить и отправить на проверку/ })).toBeTruthy();
  });
});

// ─── Редактор оператора ───────────────────────────────────────────────────────

const TOUR = {
  id: '51', title: 'Курильское озеро', short_description: null, description: 'Описание.',
  location_type: 'lake', activity_type: 'helicopter', location_name: 'Курильское озеро',
  latitude: null, longitude: null, base_price: 180000, price_old: null, price_unit: 'per_person',
  max_participants: 20, min_participants: null, duration_hours: 10, duration_type: 'day', multi_day_count: null,
  season_start: null, season_end: null, seasonal_only: false, difficulty: null, weather_dependent: true,
  is_active: true, is_published: false, included: [], not_included: [], what_to_bring: [],
  cancellation_policy: null, pickup_type: null, pickup_details: null,
  photos: ['/images/tours/a.jpg'], tour_image: null, program: null, safety_notes: null, video_clips: [],
  photo_credits: {}, on_storefront: false,
};

describe('редактор тура оператора', () => {
  let patches: Array<Record<string, unknown>>;
  let deletes: string[];

  function serve(tour: Record<string, unknown>, patchAnswer: unknown = { success: true, data: { id: '51' }, pending: null }) {
    patches = [];
    deletes = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return json(patchAnswer); }
      if (init?.method === 'DELETE') { deletes.push(u); return json({ success: true }); }
      if (u.includes('/availability')) return json({ success: true, data: [] });
      return json({ success: true, data: tour });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => { vi.restoreAllMocks(); vi.stubGlobal('confirm', () => true); });

  it('владелец: галочки «Опубликован» нет; «Сохранить» публикацию не шлёт вовсе', async () => {
    serve({ ...TOUR, is_published: true, moderation: { ...LIVE, direct: false } });
    render(<EditTourClient />);
    await screen.findByTestId('tour-moderation');
    expect(screen.queryByLabelText('Опубликован')).toBeNull();
    fireEvent.click(screen.getAllByText('Сохранить')[0]);
    await waitFor(() => expect(patches).toHaveLength(1));
    // Форма, открытая до одобрения, не должна ни ставить, ни снимать публикацию.
    expect(patches[0]).not.toHaveProperty('is_published');
    expect(patches[0].is_active).toBe(true);
  });

  it('вид длительности не записан: форма не подставляет «Однодневный» и шлёт «не записано»', async () => {
    serve({ ...TOUR, duration_type: null, is_published: true, moderation: { ...LIVE, direct: false } });
    render(<EditTourClient />);
    await screen.findByTestId('tour-moderation');
    const kind = screen.getByDisplayValue('— не указано —', { selector: 'select' }) as HTMLSelectElement;
    expect(Array.from(kind.options).map((o) => o.value)).toEqual(['', 'day', 'multi_day']);
    fireEvent.click(screen.getAllByText('Сохранить')[0]);
    await waitFor(() => expect(patches).toHaveLength(1));
    // Подставленное «day» ушло бы на проверку правкой, которой владелец не делал.
    expect(patches[0].duration_type).toBeNull();
    // Записанное значение форма шлёт как есть.
    cleanup();
    serve({ ...TOUR, duration_type: 'multi_day', is_published: true, moderation: { ...LIVE, direct: false } });
    render(<EditTourClient />);
    await screen.findByTestId('tour-moderation');
    fireEvent.click(screen.getAllByText('Сохранить')[0]);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].duration_type).toBe('multi_day');
  });

  it('владелец: «отправить на проверку» шлёт форму с просьбой; ответ сервера показан словами', async () => {
    const notice = 'Тур отправлен на проверку. Туристы увидят его после одобрения администратором.';
    serve(
      { ...TOUR, moderation: { state: 'draft', published: false, pending: null, rejected: null, direct: false } },
      { success: true, data: { id: '51' }, pending: { fields: [], wantsPublish: true, notice } },
    );
    render(<EditTourClient />);
    fireEvent.click(await screen.findByRole('button', { name: /Сохранить и отправить на проверку/ }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].is_published).toBe(true);
    expect(patches[0].title).toBe('Курильское озеро');
    expect(await screen.findByText(notice)).toBeTruthy();
    // «Изменения сохранены» без оговорки читалось бы как «на сайте».
    expect(screen.queryByText('Изменения сохранены')).toBeNull();
  });

  it('владелец: «снять с публикации» — отдельный запрос с одним полем', async () => {
    serve({ ...TOUR, is_published: true, moderation: { ...LIVE, direct: false } });
    render(<EditTourClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Снять с публикации' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ is_published: false });
  });

  it('владелец: «отозвать правку» — DELETE черновика', async () => {
    serve({
      ...TOUR, is_published: true,
      moderation: { state: 'pending', published: true, rejected: null, direct: false, pending: { changes: EDIT.changes, wantsPublish: false, since: '' } },
    });
    render(<EditTourClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Отозвать правку' }));
    await waitFor(() => expect(deletes).toEqual(['/api/hub/operator/tours/51/edit']));
    expect(patches).toHaveLength(0);
  });

  it('администратор: галочка на месте и публикация уходит в правке — он и есть проверка', async () => {
    serve({ ...TOUR, moderation: { state: 'draft', published: false, pending: null, rejected: null, direct: true } });
    render(<EditTourClient />);
    const box = await screen.findByLabelText('Опубликован');
    expect(screen.queryByTestId('tour-moderation')).toBeNull();
    fireEvent.click(box);
    fireEvent.click(screen.getAllByText('Сохранить')[0]);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].is_published).toBe(true);
  });
});

describe('список туров оператора: метка проверки', () => {
  const row = (id: string, title: string, review: string | null, published: boolean) => ({
    id, title, is_active: true, is_published: published, on_storefront: published, review,
    activity_type: 'trekking', location_name: 'Авачинский перевал', base_price: '5000',
    max_participants: 10, duration_hours: 8, difficulty: 'medium',
    tour_image: null, photos: null, rating: null, review_count: 0,
    total_bookings: '0', total_revenue: '0', created_at: '2026-10-20T00:00:00Z',
    available_slots: null, next_available_date: null,
  });

  it('метка из правки: ждёт публикации, ждёт правка, возвращён; правок нет — метки нет', () => {
    expect(tourReviewMark({ pending: { wantsPublish: true }, rejected: null })).toBe('pending_publish');
    expect(tourReviewMark({ pending: { wantsPublish: false }, rejected: null })).toBe('pending_edit');
    expect(tourReviewMark({ pending: null, rejected: { reason: 'x' } })).toBe('rejected');
    expect(tourReviewMark({ pending: null, rejected: null })).toBeNull();
    expect(tourReviewMark(undefined)).toBeNull();
  });

  it('в списке метка стоит рядом с «видит ли турист»; «не прочитано» — не «проверки нет»', async () => {
    const tours = [
      row('1', 'Новый тур', 'pending_publish', false),
      row('2', 'Тур с правкой', 'pending_edit', true),
      row('3', 'Возвращённый тур', 'rejected', false),
      row('4', 'Спокойный тур', null, true),
      row('5', 'Тур без ответа базы', 'unknown', true),
    ];
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      success: true, data: tours, pagination: { total: tours.length },
    }), { status: 200 }))) as unknown as typeof fetch;
    render(<ToursManagementClient />);
    const card = async (name: string) => within(await screen.findByRole('article', { name }));
    expect((await card('Новый тур')).getByText('На проверке')).toBeTruthy();
    expect((await card('Новый тур')).getByText('Черновик — туристы не видят')).toBeTruthy();
    expect((await card('Тур с правкой')).getByText('Правка на проверке')).toBeTruthy();
    expect((await card('Тур с правкой')).getByText('На витрине')).toBeTruthy();
    expect((await card('Возвращённый тур')).getByText('Возвращён на доработку')).toBeTruthy();
    expect((await card('Тур без ответа базы')).getByText('Проверка: не прочитано')).toBeTruthy();
    const calm = await card('Спокойный тур');
    for (const label of ['На проверке', 'Правка на проверке', 'Возвращён на доработку', 'Проверка: не прочитано']) {
      expect(calm.queryByText(label), label).toBeNull();
    }
  });
});

// ─── Кабинет гида ─────────────────────────────────────────────────────────────

const GUIDE_TOUR = {
  id: '12', title: 'Авача', slug: null, is_published: false, is_active: true, base_price: '15000', price_unit: 'per_person',
  max_participants: 4, short_description: null, description: 'Есть.', program: null, included: null, not_included: null,
  what_to_bring: null, safety_notes: null, photos: [], video_clips: [], partner_name: 'Гид Тест', photo_credits: {},
  season_start: null, season_end: null, open_dates: 0, on_storefront: false, blockers: [] as string[],
  moderation: { state: 'draft', pending: null, rejected: null },
} as unknown as React.ComponentProps<typeof OwnTourCard>['tour'];

describe('кабинет гида: свой тур и проверка', () => {
  let calls: Array<{ url: string; method: string; body: unknown }>;
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
      return {
        ok: true, status: 200,
        json: async () => ({ success: true, message: 'готово', data: { id: '12' }, pending: { notice: 'Правка отправлена на проверку (цена). На витрине пока прежняя версия.' } }),
      } as Response;
    }));
  });

  it('слова состояния: проверка названа рядом с «на сайте» и «черновик»', () => {
    expect(ownTourReviewWords(false, null)).toBe('черновик — туристы не видят');
    expect(ownTourReviewWords(true, { state: 'live', pending: null, rejected: null })).toBe('на сайте');
    expect(ownTourReviewWords(false, { state: 'pending', pending: { wantsPublish: true }, rejected: null })).toBe('на проверке — туристы увидят после одобрения');
    expect(ownTourReviewWords(true, { state: 'pending', pending: { wantsPublish: false }, rejected: null })).toBe('на сайте · правка на проверке');
    expect(ownTourReviewWords(false, { state: 'rejected', pending: null, rejected: { wantsPublish: true } })).toBe('возвращён на доработку — туристы не видят');
    expect(ownTourReviewWords(true, { state: 'rejected', pending: null, rejected: { wantsPublish: false } })).toBe('на сайте · правка отклонена');
  });

  it('тур ждёт проверки: кнопки «отправить» нет, есть «отозвать» — DELETE черновика', async () => {
    const done = vi.fn();
    const tour = { ...GUIDE_TOUR, moderation: { state: 'pending', pending: { changes: [], wantsPublish: true, since: '' }, rejected: null } } as typeof GUIDE_TOUR;
    render(<ul><OwnTourCard tour={tour} onDone={done} /></ul>);
    expect(screen.getByText('на проверке — туристы увидят после одобрения')).toBeTruthy();
    expect(screen.getByTestId('own-tour-review').textContent).toContain('на сайт он выйдет после одобрения');
    expect(screen.queryByRole('button', { name: /Отправить на проверку/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Отозвать с проверки/ }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls.at(-1)).toEqual({ url: '/api/guide/own/tours/12/edit', method: 'DELETE', body: null });
  });

  it('правка тура на сайте ждёт проверки: дифф виден, «Снять с сайта» остаётся', () => {
    const tour = {
      ...GUIDE_TOUR, is_published: true, on_storefront: true,
      moderation: { state: 'pending', pending: { changes: EDIT.changes, wantsPublish: false, since: '' }, rejected: null },
    } as typeof GUIDE_TOUR;
    render(<ul><OwnTourCard tour={tour} onDone={vi.fn()} /></ul>);
    expect(screen.getByText('на сайте · правка на проверке')).toBeTruthy();
    expect(within(screen.getByTestId('own-tour-review')).getAllByTestId('tour-edit-change')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Снять с сайта/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Отозвать правку/ })).toBeTruthy();
  });

  it('отказ: причина администратора видна на карточке тура', () => {
    const tour = {
      ...GUIDE_TOUR,
      moderation: { state: 'rejected', pending: null, rejected: { reason: 'Нет программы дня', fields: [], wantsPublish: true, at: null } },
    } as typeof GUIDE_TOUR;
    render(<ul><OwnTourCard tour={tour} onDone={vi.fn()} /></ul>);
    expect(screen.getByTestId('own-tour-review').textContent).toContain('Тур возвращён на доработку.');
    expect(screen.getByTestId('own-tour-review').textContent).toContain('Причина: Нет программы дня');
    expect(screen.getByRole('button', { name: /Отправить на проверку/ })).toBeTruthy();
  });

  it('форма: правка ушла на проверку — гиду сказано это, а не «сохранено»', async () => {
    const done = vi.fn();
    render(<OwnTourForm tour={{ ...GUIDE_TOUR, is_published: true } as typeof GUIDE_TOUR} onDone={done} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Цена, ₽'), { target: { value: '16000' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Правка тура «Авача»' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(done.mock.calls[0][0]).toBe('«Авача»: Правка отправлена на проверку (цена). На витрине пока прежняя версия.');
  });

  it('чат гида: перед «Сохранить» сказано, куда уйдёт правка', () => {
    expect(afterSaveWords({ throughReview: true })).toBe('Правка уйдёт на проверку администратору: на сайте до одобрения — прежняя версия.');
    expect(afterSaveWords({ throughReview: false })).toBe('Тур не на витрине: правка запишется сразу, туристы увидят её после публикации.');
  });
});

// ─── Сообщение владельцу о решении ────────────────────────────────────────────

describe('сообщение владельцу о решении', () => {
  const base = { partnerId: 'p1', subject: 'tour' as const, label: 'Вулкан <Горелый>', reason: null };

  it('четыре текста: новый тур и правка, одобрено и отклонено', () => {
    expect(editDecisionText({ ...base, outcome: 'approved', firstPublication: true }))
      .toBe('<b>Тур одобрен</b>\n«Вулкан &lt;Горелый&gt;»: проверка пройдена, тур опубликован.');
    expect(editDecisionText({ ...base, outcome: 'approved', firstPublication: false, fieldsWords: 'цена, фото' }))
      .toBe('<b>Правка тура одобрена</b>\n«Вулкан &lt;Горелый&gt;»: правка на сайте (цена, фото).');
    expect(editDecisionText({ ...base, outcome: 'rejected', firstPublication: true, reason: 'Нет <программы>' }))
      .toBe('<b>Тур не опубликован</b>\n«Вулкан &lt;Горелый&gt;»: на сайт не вышел.\nПричина: Нет &lt;программы&gt;\nИсправить и отправить на проверку ещё раз можно в кабинете на сайте.');
    expect(editDecisionText({ ...base, outcome: 'rejected', firstPublication: false, fieldsWords: 'цена' }))
      .toBe('<b>Правка тура отклонена</b>\n«Вулкан &lt;Горелый&gt;»: на сайте прежняя версия (цена).\nПричина не записана.\nИсправить и отправить на проверку ещё раз можно в кабинете на сайте.');
  });

  it('уходит адресно в канал владельца, с кнопкой в его кабинет; в тексте нет ни телефона, ни почты', async () => {
    h.reach.mockResolvedValue({ reachable: true, maxChatId: 777, telegramChatId: null });
    h.send.mockResolvedValue({ channel: 'max', delivered: true });
    const out = await notifyPartnerEditDecision({
      ...base, outcome: 'approved', firstPublication: false, fieldsWords: 'цена', cabinetPath: '/hub/guide/own',
    });
    expect(out).toEqual({ state: 'delivered', channel: 'max' });
    const sent = h.send.mock.calls.at(-1)![0] as { text: string; stub: string; to: unknown; buttons: Array<{ url: string }> };
    expect(sent.to).toEqual({ maxChatId: 777, telegramChatId: null });
    expect(sent.buttons[0].url).toMatch(/\/hub\/guide\/own$/);
    expect(sent.stub).toBe(sent.text);
    expect(sent.text).not.toMatch(/\+7|\d{10,}|@/);
  });

  it('канала нет или адрес не прочитан — не отправлено и названо; запрос не падает', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.send.mockClear();
    h.reach.mockResolvedValue({ reachable: false, maxChatId: null, telegramChatId: null });
    expect(await notifyPartnerEditDecision({ ...base, outcome: 'approved' })).toEqual({ state: 'no_channel' });
    h.reach.mockResolvedValue(null);
    expect(await notifyPartnerEditDecision({ ...base, outcome: 'approved' })).toEqual({ state: 'unknown' });
    expect(h.send).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});

// ─── Дверь решения администратора ─────────────────────────────────────────────

describe('дверь решения: POST /api/admin/moderation/tour-edits/[id]', () => {
  const ID = 'e1000000-0000-4000-8000-000000000001';
  const SEEN = 'a'.repeat(64);
  const done = { partnerId: 'p1', tourId: '51', title: 'Вулкан Горелый', fields: ['base_price'], partnerCategory: 'guide', automatonFields: [] as string[] };

  async function post(body: unknown, id = ID) {
    vi.doMock('@/lib/notifications/partner-edit-notify', () => ({ notifyPartnerEditDecisionQuietly: h.notify }));
    const { POST } = await import('@/app/api/admin/moderation/tour-edits/[id]/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/admin/moderation/tour-edits/${id}`, { method: 'POST', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    );
    return { status: res.status, body: await res.json() };
  }

  beforeEach(() => { h.decide.mockReset(); h.notify.mockClear(); h.ping.mockClear(); vi.resetModules(); });

  it('одобрение без отпечатка карточки, отказ без причины, чужой id — 400, решение не зовётся', async () => {
    expect((await post({ action: 'approve' })).status).toBe(400);
    expect((await post({ action: 'approve', seen: 'коротко' })).status).toBe(400);
    expect((await post({ action: 'reject', reason: 'нет' })).status).toBe(400);
    expect((await post({ action: 'approve', seen: SEEN }, 'не-uuid')).status).toBe(400);
    expect((await post({ action: 'publish', seen: SEEN })).status).toBe(400);
    expect(h.decide).not.toHaveBeenCalled();
  });

  it('одобрено: поисковикам — после решения, владельцу — сообщение о туре', async () => {
    h.decide.mockResolvedValue({ outcome: 'approved', ...done, published: false, askedPublish: false });
    const r = await post({ action: 'approve', seen: SEEN });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('«Вулкан Горелый»: правка на сайте');
    expect(h.decide).toHaveBeenCalledWith(expect.objectContaining({ id: ID, action: 'approve', seen: SEEN, reason: null }));
    expect(h.ping).toHaveBeenCalledWith('51');
    expect(h.notify).toHaveBeenCalledWith({
      partnerId: 'p1', subject: 'tour', label: 'Вулкан Горелый', outcome: 'approved', reason: null,
      firstPublication: false, fieldsWords: 'цена', cabinetPath: '/hub/guide/own',
      // Правку прислал владелец: про платформу в сообщении ничего.
      platformFieldsWords: undefined, platformOnly: false,
    });
  });

  it('правку предложил автомат: одобрение сообщается владельцу как предложение платформы, отказ — не сообщается вовсе', async () => {
    const auto = { ...done, fields: ['description'], automatonFields: ['description'] };
    h.decide.mockResolvedValue({ outcome: 'approved', ...auto, published: false, askedPublish: false });
    expect((await post({ action: 'approve', seen: SEEN })).body.message).toBe('«Вулкан Горелый»: правка на сайте');
    expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: 'approved', fieldsWords: 'описание', platformFieldsWords: 'описание', platformOnly: true,
    }));
    h.notify.mockClear();
    h.decide.mockResolvedValue({ outcome: 'rejected', ...auto, published: false, askedPublish: false });
    const no = await post({ action: 'reject', reason: 'Текст повторяет программу' });
    expect(no.status).toBe(200);
    expect(no.body.message).toBe('«Вулкан Горелый»: предложение автомата отклонено, на сайте прежняя версия');
    // Владелец правку не присылал, на его туре ничего не изменилось.
    expect(h.notify).not.toHaveBeenCalled();

    // В правке есть и поле владельца — отказ ему сообщается, с припиской о платформе.
    const mixed = { ...done, fields: ['description', 'base_price'], automatonFields: ['description'] };
    h.decide.mockResolvedValue({ outcome: 'rejected', ...mixed, published: false, askedPublish: false });
    expect((await post({ action: 'reject', reason: 'Цена не сходится' })).body.message)
      .toBe('«Вулкан Горелый»: правка отклонена, на сайте прежняя версия');
    expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: 'rejected', fieldsWords: 'описание, цена', platformFieldsWords: 'описание', platformOnly: false,
    }));
    // Автомат дописал поле к туру, который владелец отправил на публикацию: решение — о туре, владельцу сообщается.
    h.notify.mockClear();
    h.decide.mockResolvedValue({ outcome: 'rejected', ...auto, published: false, askedPublish: true });
    await post({ action: 'reject', reason: 'Нет программы дня' });
    expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ firstPublication: true, platformOnly: false }));
  });

  it('новый тур одобрен — «опубликован»; отклонён — «не опубликован», поисковикам ничего', async () => {
    h.decide.mockResolvedValue({ outcome: 'approved', ...done, fields: [], published: true, askedPublish: true });
    expect((await post({ action: 'approve', seen: SEEN })).body.message).toBe('«Вулкан Горелый»: тур опубликован');
    h.ping.mockClear();
    h.decide.mockResolvedValue({ outcome: 'rejected', ...done, fields: [], published: false, askedPublish: true });
    const r = await post({ action: 'reject', reason: 'Нет программы дня' });
    expect(r.body.message).toBe('«Вулкан Горелый»: тур не опубликован');
    expect(h.decide).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'reject', reason: 'Нет программы дня', seen: null }));
    expect(h.ping).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'rejected', reason: 'Нет программы дня', firstPublication: true }));
  });

  it('правка изменилась, решение уже есть, правки нет, база не ответила — свой код, без сообщения и пинга', async () => {
    // Место из правки скрыли или слили, пока она ждала: администратору сказано, что делать.
    h.decide.mockResolvedValue({ outcome: 'place_gone' });
    const gone = await post({ action: 'approve', seen: SEEN });
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe('place_gone');
    expect(gone.body.error).toBe('Главное место из правки скрыто или слито в другое, пока правка ждала. Тур не изменён — верните правку владельцу с причиной.');
    for (const [outcome, status] of [['changed', 409], ['bad_photo', 409], ['already', 409], ['not_found', 404], ['db_error', 503]] as const) {
      h.decide.mockResolvedValue({ outcome });
      const r = await post({ action: 'approve', seen: SEEN });
      expect(r.status, outcome).toBe(status);
      expect(r.body.success).toBe(false);
    }
    // Адрес, который не снимок: администратору сказано, что делать, — вернуть правку.
    h.decide.mockResolvedValue({ outcome: 'bad_photo' });
    const bad = await post({ action: 'approve', seen: SEEN });
    expect(bad.body.code).toBe('bad_photo');
    expect(bad.body.error).toBe('В правке есть адрес снимка, который снимком не является. Тур не изменён — верните правку владельцу с причиной.');
    expect((await (async () => { h.decide.mockResolvedValue({ outcome: 'changed' }); return post({ action: 'approve', seen: SEEN }); })()).body.code).toBe('changed');
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.ping).not.toHaveBeenCalled();
  });
});

describe('отзыв правки гидом: DELETE /api/guide/own/tours/[id]/edit', () => {
  const del = async (id: string) => {
    const { DELETE } = await import('@/app/api/guide/own/tours/[id]/edit/route');
    const res = await DELETE(new NextRequest(`http://localhost/api/guide/own/tours/${id}/edit`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() };
  };
  beforeEach(() => { h.withdraw.mockReset(); h.guidePartner.mockReset().mockResolvedValue('g1'); });

  it('отзывается правка своей карточки: владение — в самом удалении', async () => {
    h.withdraw.mockResolvedValue('withdrawn');
    const r = await del('12');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, message: 'Отозвано с проверки. На сайте — то, что было.' });
    expect(h.withdraw).toHaveBeenCalledWith('12', 'g1');
  });

  it('правки нет — 404; база не ответила — 503, а не «нет»; номер не число — 400; карточки гида нет — 404', async () => {
    h.withdraw.mockResolvedValue('none');
    expect((await del('12')).status).toBe(404);
    h.withdraw.mockResolvedValue('db_error');
    expect((await del('12')).status).toBe(503);
    h.withdraw.mockClear();
    expect((await del('12; drop')).status).toBe(400);
    h.guidePartner.mockResolvedValue(null);
    expect((await del('12')).status).toBe(404);
    expect(h.withdraw).not.toHaveBeenCalled();
  });
});

// ─── Запреты ──────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
const SOURCES = [...walk('app'), ...walk('lib'), ...walk('components')];

/** Двери владельца тура: кабинет оператора, кабинет и чат гида, CRM, ИИ-чат. */
const OWNER_DOOR = /^(app\/api\/(hub\/operator|operator|guide)\/|lib\/(guides|crm|operators|operator|chat-cabinet|roles|max)\/|lib\/agents\/(sdk|agencies)\/)/;

describe('запреты', () => {
  it('общую запись тура зовут только единая дверь и одобрение — владелец мимо них не пишет', () => {
    const callers = SOURCES.filter((f) => /\bwriteTourPatch\(/.test(read(f)));
    expect(callers.sort()).toEqual(['lib/tours/moderation-review.ts', 'lib/tours/tour-change.ts', 'lib/tours/tour-write.ts']);
  });

  it('в дверях владельца нет своего UPDATE содержания тура и своей публикации', () => {
    const moderated = MODERATED_TOUR_COLUMNS.join('|');
    const offenders: string[] = [];
    for (const file of SOURCES.filter((f) => OWNER_DOOR.test(f))) {
      const src = read(file);
      for (const m of src.matchAll(/UPDATE\s+operator_tours\b[\s\S]{0,600}?(?:WHERE|RETURNING|`)/gi)) {
        const set = m[0];
        // Поле с проверкой, публикация или имя колонки из переменной — мимо очереди.
        if (new RegExp(`\\b(${moderated})\\s*=`, 'i').test(set)) offenders.push(`${file}: содержание`);
        if (/\bis_published\s*=\s*(true|\$)/i.test(set)) offenders.push(`${file}: публикация`);
        if (/SET\s+\$\{/i.test(set)) offenders.push(`${file}: колонка из переменной`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('таблицу черновиков читают только названные файлы; публичного чтения нет', () => {
    const readers = SOURCES.filter((f) => /\boperator_tour_edits\b/.test(read(f))).sort();
    expect(readers).toEqual([
      'lib/account/erase.ts',            // удаление аккаунта: таблица названа в ERASE_KEEP с причиной, SQL к ней нет
      'lib/admin/partner-queues.ts',     // отчёт очередей администратора: счёт ждущих, только чтение (этап 6)
      'lib/guides/tour-edit/store.ts',   // «тур идёт через проверку» — слова чата гида перед сохранением
      'lib/partners/readiness-store.ts', // счёт «на проверке» в чек-листе готовности
      'lib/tours/moderation-read.ts',    // правки владельца для его кабинета — только чтение
      'lib/tours/moderation-review.ts',  // очередь администратора и решение
      'lib/tours/moderation-store.ts',   // черновик: положить и отозвать
      'lib/tours/moderation.ts',         // упоминание в шапке правила
    ]);
    // Читающие модули не пишут: ни INSERT, ни UPDATE, ни DELETE.
    for (const reader of ['lib/tours/moderation-read.ts', 'lib/admin/partner-queues.ts']) {
      expect(read(reader), reader).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\b/);
    }
  });

  it('склад черновиков и единую дверь подключают только кабинеты владельца и админка', () => {
    const users = SOURCES.filter((f) => /from '@\/lib\/tours\/(moderation-store|moderation-read|tour-change)'/.test(read(f)));
    const outside = users.filter((f) => !OWNER_DOOR.test(f)
      && !['lib/tours/moderation-store.ts', 'lib/tours/moderation-review.ts', 'lib/tours/tour-change.ts'].includes(f));
    // Вне кабинетов дверь подключают только автоматы платформы — и только
    // своим входом: дверью человека автомат прошёл бы без пометки «кто
    // предложил», а с пустой карточкой тура — как администратор, мимо очереди.
    const automata = outside.filter((f) => /proposeTourChange/.test(read(f)));
    expect(automata).toEqual(['lib/tours/describe-door.ts']);
    for (const f of automata) {
      const src = read(f);
      expect(src, `${f}: автомат зовёт дверь человека`).not.toMatch(/saveTourChange|stageTourEdit|writeTourPatch/);
      expect(src, `${f}: автомат не читает тур под замком`).toMatch(/readTourForAutomaton/);
    }
    expect(outside.filter((f) => !automata.includes(f))).toEqual([]);
    // Решение — только у дверей администратора: владелец свою правку не одобряет.
    const deciders = SOURCES.filter((f) => /from '@\/lib\/tours\/moderation-review'/.test(read(f))).sort();
    expect(deciders).toEqual([
      'app/api/admin/moderation/tour-edits/[id]/route.ts',
      'app/api/admin/moderation/tour-edits/route.ts',
    ]);
    // Витрина судит тур одним шлюзом и о черновиках не знает.
    expect(read('lib/tours/public-visibility.ts')).not.toMatch(/operator_tour_edits|moderation-store/);
  });

  it('миграция 1507 живые туры не трогает: ни UPDATE, ни снятия с публикации', () => {
    const sql = read('migrations/1507_operator_tour_edits.sql').replace(/--.*$/gm, '');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS operator_tour_edits/);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+operator_tours/i);
  });
});
