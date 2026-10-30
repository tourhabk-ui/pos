// @vitest-environment node
/**
 * «Занято с 5 по 9 ноября» — занятость объекта жилья без номеров словами
 * хозяина (слово владельца 30.10: хозяин «Кутхи» «сейчас на бумажке
 * посмотрю, когда занято»).
 *
 * Сторож держит вызовом:
 *   · разбор фразы: «с … по …», одна дата, числа через точку, через Новый
 *     год, ближайший год без года, прошлое, порядок, потолок, не про занятость;
 *   · запись: только свой объект, INSERT на уровне объекта (room_id IS NULL)
 *     с ON CONFLICT по частичному индексу 721, «свободно» снимает только
 *     блоки объекта; несколько объектов — просят назвать; база упала — сказано;
 *   · экран «Занято»: отрезки, кнопка «Освободить» у каждого (payload короче
 *     64 байт и разбирается), не прочиталось — сказано, не «всё свободно»;
 *   · строка меню роли stay: «Заявки», «Занято», «Помощь»; «занято» словом —
 *     раздел, не запись; кнопка `rm:st:bz` — только у жилья;
 *   · гость: карточка отдаёт занятые ночи объекта без номеров (UNION к
 *     формуле номеров), заявка на закрытые даты не пишется и называет даты,
 *     каталог при датах не выкидывает объект без номеров, если даты открыты.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pool, dbQuery } = vi.hoisted(() => ({ pool: vi.fn(), dbQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => pool(...a) } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));

import {
  parseBusyPhrase, groupRanges, rangeWords, busyWithin, guestBusyText, busySavedText, busyScreenLines, isBusyScreenAsk,
  nightsInclusive, BUSY_MAX_DAYS, BUSY_TEXT,
} from '@/lib/stay/busy-dates';
import {
  handleStayBusyPhrase, setObjectBusy, loadOwnerBusy, pickObjectByWords, BLOCK_SQL, RELEASE_SQL, objectBusyNightsSql,
} from '@/lib/stay/busy-flow';
import { busyScreen, BUSY_RELEASE_BUTTONS_MAX, moreScreen } from '@/lib/chat-cabinet/screens';
import { cabinetPayload, parseCabinetPress } from '@/lib/chat-cabinet/payload';
import { parseRoleMenuPress, partnerMenu, roleMenuAsk } from '@/lib/roles/role-menu';
import { isCabinetSection } from '@/lib/roles/role-screen';

const TODAY = '2026-10-30';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const ACC = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const ACC2 = '4f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f608';

beforeEach(() => {
  pool.mockReset();
  dbQuery.mockReset();
});

describe('разбор фразы', () => {
  const ok = (text: string) => {
    const p = parseBusyPhrase(text, TODAY);
    if (!p.ok) throw new Error(`не разобралось: ${p.reason}`);
    return p.command;
  };

  it('«с 5 по 9 ноября» — включительно, ближайший ноябрь; одна дата; числа через точку; с названием объекта', () => {
    expect(ok('занято с 5 по 9 ноября')).toEqual({ action: 'block', from: '2026-11-05', to: '2026-11-09', objectWords: null });
    expect(nightsInclusive('2026-11-05', '2026-11-09')).toBe(5);
    expect(ok('Занято 7 ноября')).toMatchObject({ from: '2026-11-07', to: '2026-11-07' });
    expect(ok('занято 05.11–09.11')).toMatchObject({ from: '2026-11-05', to: '2026-11-09' });
    expect(ok('занято с 05.11.2026 по 09.11.26')).toMatchObject({ from: '2026-11-05', to: '2026-11-09' });
    expect(ok('занято Кутха с 5 по 9 ноября')).toMatchObject({ objectWords: 'Кутха' });
    expect(ok('Занято: домик у реки, 5-9 ноября')).toMatchObject({ objectWords: 'домик у реки', from: '2026-11-05', to: '2026-11-09' });
  });

  it('год без года — ближайшее будущее; через Новый год начало годом раньше; прошедшая часть отрезка — с сегодня', () => {
    expect(ok('занято с 1 по 10 февраля')).toMatchObject({ from: '2027-02-01', to: '2027-02-10' });
    expect(ok('занято с 28 декабря по 3 января')).toMatchObject({ from: '2026-12-28', to: '2027-01-03' });
    expect(ok('занято с 28 октября по 2 ноября')).toMatchObject({ from: TODAY, to: '2026-11-02' });
  });

  it('«свободно» и «освободилось» — снять', () => {
    expect(ok('свободно с 5 по 9 ноября')).toMatchObject({ action: 'release', from: '2026-11-05', to: '2026-11-09' });
    expect(ok('освободилось 7 ноября')).toMatchObject({ action: 'release' });
  });

  it('отказы названы: не про занятость, нет дат, порядок, прошлое, потолок', () => {
    expect(parseBusyPhrase('привет, как дела', TODAY)).toEqual({ ok: false, reason: 'not_busy' });
    expect(parseBusyPhrase('занятость', TODAY)).toEqual({ ok: false, reason: 'not_busy' });
    expect(parseBusyPhrase('занято', TODAY)).toEqual({ ok: false, reason: 'no_dates' });
    expect(parseBusyPhrase('занято завтра', TODAY)).toEqual({ ok: false, reason: 'no_dates' });
    expect(parseBusyPhrase('занято 5 человек', TODAY)).toEqual({ ok: false, reason: 'no_dates' });
    expect(parseBusyPhrase('занято с 9 по 5 ноября', TODAY)).toEqual({ ok: false, reason: 'order' });
    expect(parseBusyPhrase('занято 1 января 2020', TODAY)).toEqual({ ok: false, reason: 'past' });
    expect(parseBusyPhrase('занято с 1 ноября по 1 июня', TODAY)).toEqual({ ok: false, reason: 'too_long' });
    expect(BUSY_MAX_DAYS).toBe(180);
  });

  it('отрезки и слова гостю: подряд идущие даты склеиваются, пересечение с заявкой [заезд, выезд)', () => {
    const ranges = groupRanges(['2026-11-07', '2026-11-05', '2026-11-06', '2026-11-20', '2026-11-05']);
    expect(ranges).toEqual([{ from: '2026-11-05', to: '2026-11-07' }, { from: '2026-11-20', to: '2026-11-20' }]);
    expect(ranges.map(rangeWords)).toEqual(['с 05.11.2026 по 07.11.2026', '20.11.2026']);
    // Выезд 20-го: ночь 20-го в заявку не входит.
    expect(busyWithin(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-20'], '2026-11-06', '2026-11-20'))
      .toEqual([{ from: '2026-11-06', to: '2026-11-07' }]);
    expect(guestBusyText([{ from: '2026-11-06', to: '2026-11-07' }])).toContain('Хозяин отметил эти даты занятыми: с 06.11.2026 по 07.11.2026');
    expect(guestBusyText([])).toBe('');
  });

  it('слова хозяину: даты, ночи, как отменить; ни «забронировано», ни оплаты', () => {
    const saved = busySavedText({ name: 'Кутха', from: '2026-11-05', to: '2026-11-09', action: 'block' });
    expect(saved).toContain('«Кутха» занято с 05.11.2026 по 09.11.2026 (5 ночей)');
    expect(saved).toContain('напишите «свободно с 05.11.2026 по 09.11.2026»');
    expect(saved).not.toMatch(/заброниров|оплат/i);
    expect(busySavedText({ name: 'Кутха', from: '2026-11-07', to: '2026-11-07', action: 'release' })).toContain('свободно 07.11.2026');
    expect(isBusyScreenAsk('Занято')).toBe(true);
    expect(isBusyScreenAsk('что занято?')).toBe(true);
    expect(isBusyScreenAsk('занято с 5 по 9 ноября')).toBe(false);
  });
});

describe('запись', () => {
  it('блок — INSERT уровня объекта с ON CONFLICT по частичному индексу 721; «свободно» снимает только блоки объекта; чужой — не записан', async () => {
    pool.mockResolvedValueOnce({ rows: [{ name: 'Кутха' }] }).mockResolvedValueOnce({ rows: [], rowCount: 5 });
    const r = await setObjectBusy({ partnerId: PARTNER, accommodationId: ACC, from: '2026-11-05', to: '2026-11-09', action: 'block', via: 'max' });
    expect(r).toEqual({ outcome: 'saved', name: 'Кутха' });
    expect(String(pool.mock.calls[0]![0])).toContain('partner_id = $2::uuid');
    const [sql, params] = pool.mock.calls[1]!;
    expect(sql).toBe(BLOCK_SQL);
    expect(BLOCK_SQL).toContain('NULL::uuid');
    expect(BLOCK_SQL).toContain('ON CONFLICT (accommodation_id, date) WHERE room_id IS NULL');
    expect(BLOCK_SQL).toContain('DO UPDATE SET is_blocked = TRUE');
    expect(params).toEqual([ACC, '2026-11-05', '2026-11-09', 'хозяин: занято (max)']);

    pool.mockReset();
    pool.mockResolvedValueOnce({ rows: [{ name: 'Кутха' }] }).mockResolvedValueOnce({ rows: [], rowCount: 2 });
    await setObjectBusy({ partnerId: PARTNER, accommodationId: ACC, from: '2026-11-05', to: '2026-11-09', action: 'release', via: 'telegram' });
    expect(pool.mock.calls[1]![0]).toBe(RELEASE_SQL);
    expect(RELEASE_SQL).toContain('SET is_blocked = FALSE');
    expect(RELEASE_SQL).toContain('room_id IS NULL AND is_blocked = TRUE');
    expect(RELEASE_SQL).toContain('date >= $2::date AND date <= $3::date');

    pool.mockReset();
    pool.mockResolvedValueOnce({ rows: [] });
    expect(await setObjectBusy({ partnerId: PARTNER, accommodationId: ACC, from: '2026-11-05', to: '2026-11-09', action: 'block', via: 'max' }))
      .toEqual({ outcome: 'not_yours' });
    expect(pool).toHaveBeenCalledTimes(1);

    pool.mockReset();
    pool.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '57P01' }));
    expect(await setObjectBusy({ partnerId: PARTNER, accommodationId: ACC, from: '2026-11-05', to: '2026-11-09', action: 'block', via: 'max' }))
      .toEqual({ outcome: 'db_error' });
  });

  it('фраза в чате: один объект — записано и названо; не хозяин — null; без дат — подсказка; база — сказано', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    pool
      .mockResolvedValueOnce({ rows: [{ id: ACC, name: 'Кутха' }] })
      .mockResolvedValueOnce({ rows: [{ name: 'Кутха' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 5 });
    const text = await handleStayBusyPhrase({ partnerId: PARTNER, category: 'stay', text: 'занято с 5 по 9 ноября', today: TODAY, via: 'max' });
    expect(text).toContain('«Кутха» занято с 05.11.2026 по 09.11.2026 (5 ночей)');
    expect(pool.mock.calls[2]![1]).toEqual([ACC, '2026-11-05', '2026-11-09', 'хозяин: занято (max)']);

    expect(await handleStayBusyPhrase({ partnerId: PARTNER, category: 'transfer', text: 'занято с 5 по 9 ноября', today: TODAY, via: 'max' })).toBeNull();
    expect(await handleStayBusyPhrase({ partnerId: PARTNER, category: 'stay', text: 'спасибо', today: TODAY, via: 'max' })).toBeNull();
    expect(await handleStayBusyPhrase({ partnerId: PARTNER, category: 'stay', text: 'занято завтра', today: TODAY, via: 'max' })).toContain('Не разобрал даты');

    pool.mockReset();
    pool.mockRejectedValueOnce(new Error('down'));
    expect(await handleStayBusyPhrase({ partnerId: PARTNER, category: 'stay', text: 'занято 7 ноября', today: TODAY, via: 'max' })).toBe(BUSY_TEXT.saveFailed);
    pool.mockReset();
    pool.mockResolvedValueOnce({ rows: [] });
    expect(await handleStayBusyPhrase({ partnerId: PARTNER, category: 'stay', text: 'занято 7 ноября', today: TODAY, via: 'max' })).toBe(BUSY_TEXT.noObjects);
    warn.mockRestore();
  });

  it('несколько объектов: без названия — просят назвать; с названием — записывается названный; неизвестное название — список своих', async () => {
    const two = { rows: [{ id: ACC, name: 'Кутха' }, { id: ACC2, name: 'Домик у реки' }] };
    pool.mockResolvedValueOnce(two);
    const ask = await handleStayBusyPhrase({ partnerId: PARTNER, category: 'stay', text: 'занято с 5 по 9 ноября', today: TODAY, via: 'max' });
    expect(ask).toContain('У вас несколько объектов: «Кутха», «Домик у реки»');
    expect(ask).toContain('«занято Кутха с 5 по 9 ноября»');
    expect(pool).toHaveBeenCalledTimes(1);

    pool.mockReset();
    pool.mockResolvedValueOnce(two).mockResolvedValueOnce({ rows: [{ name: 'Домик у реки' }] }).mockResolvedValueOnce({ rows: [] });
    const saved = await handleStayBusyPhrase({ partnerId: PARTNER, category: 'stay', text: 'занято домик с 5 по 9 ноября', today: TODAY, via: 'max' });
    expect(saved).toContain('«Домик у реки» занято');
    expect(pool.mock.calls[1]![1]).toEqual([ACC2, PARTNER]);

    pool.mockReset();
    pool.mockResolvedValueOnce(two);
    expect(await handleStayBusyPhrase({ partnerId: PARTNER, category: 'stay', text: 'занято баня с 5 по 9 ноября', today: TODAY, via: 'max' }))
      .toContain('Объекта «баня» среди ваших нет. Ваши объекты: «Кутха», «Домик у реки»');
    expect(pickObjectByWords(two.rows, 'у реки')).toEqual({ id: ACC2, name: 'Домик у реки' });
    expect(pickObjectByWords([{ id: ACC, name: 'Дом 1' }, { id: ACC2, name: 'Дом 2' }], 'дом')).toBe('ambiguous');
  });

  it('чтение занятости — по объектам хозяина, с сегодня на окно; не прочиталось — null', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    pool.mockResolvedValueOnce({ rows: [
      { id: ACC, name: 'Кутха', date: '2026-11-05' }, { id: ACC, name: 'Кутха', date: '2026-11-06' }, { id: ACC2, name: 'Домик у реки', date: null },
    ] });
    expect(await loadOwnerBusy(PARTNER, TODAY)).toEqual([
      { id: ACC, name: 'Кутха', dates: ['2026-11-05', '2026-11-06'] }, { id: ACC2, name: 'Домик у реки', dates: [] },
    ]);
    const [sql, params] = pool.mock.calls[0]!;
    expect(String(sql)).toContain('av.room_id IS NULL AND av.is_blocked = TRUE');
    expect(params).toEqual([PARTNER, TODAY, 180]);
    pool.mockRejectedValueOnce(new Error('down'));
    expect(await loadOwnerBusy(PARTNER, TODAY)).toBeNull();
    warn.mockRestore();
  });
});

describe('экран «Занято» и строка меню', () => {
  it('отрезки словами, «Освободить» у каждого — payload короче 64 байт и разбирается; не прочиталось — сказано; пусто — всё открыто', () => {
    const s = busyScreen({ objects: [{ id: ACC, name: 'Кутха', dates: ['2026-11-05', '2026-11-06', '2026-11-20'] }], base: 'https://vedarai.ru' });
    expect(s.text).toContain('<b>Кутха</b>');
    expect(s.text).toContain('• с 05.11.2026 по 06.11.2026 (2 ночи)');
    expect(s.text).toContain('• 20.11.2026 (1 ночь)');
    expect(s.text).toContain('«занято с 5 по 9 ноября»');
    expect(s.pd).toBe(false);
    const release = s.rows.flat().filter((b) => 'payload' in b && b.payload.startsWith('cb:b:r:'));
    expect(release.map((b) => b.text)).toEqual(['Освободить с 05.11.2026 по 06.11.2026', 'Освободить 20.11.2026']);
    for (const b of release) {
      if (!('payload' in b)) continue;
      expect(Buffer.byteLength(b.payload)).toBeLessThan(64);
    }
    expect(parseCabinetPress(cabinetPayload.busyRelease(ACC, '2026-11-05', '2026-11-06')))
      .toEqual({ kind: 'busy_release', accommodationId: ACC, from: '2026-11-05', to: '2026-11-06' });
    expect(parseCabinetPress('cb:b')).toEqual({ kind: 'busy' });
    expect(parseCabinetPress(`cb:b:r:${ACC}:20261131:20261205`)).toBeNull();
    expect(parseCabinetPress(`cb:b:r:${ACC}:20261206:20261205`)).toBeNull();

    const failed = busyScreen({ objects: null, base: 'https://vedarai.ru' });
    expect(failed.text).toContain(BUSY_TEXT.failed);
    expect(failed.rows.flat().some((b) => 'payload' in b && b.payload.startsWith('cb:b:r:'))).toBe(false);
    const empty = busyScreen({ objects: [{ id: ACC, name: 'Кутха', dates: [] }], base: 'https://vedarai.ru' });
    expect(empty.text).toContain('Занятых дат не записано — для гостей всё открыто.');
    expect(busyScreenLines([], undefined)).toContain(BUSY_TEXT.noObjects);
  });

  it('кнопок «Освободить» не больше шести; у двух объектов кнопка называет объект', () => {
    const dates = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i * 2 + 1).padStart(2, '0')}`);
    const s = busyScreen({ objects: [{ id: ACC, name: 'Кутха', dates }, { id: ACC2, name: 'Домик', dates: ['2026-12-01'] }], base: 'https://vedarai.ru' });
    const release = s.rows.flat().filter((b) => 'payload' in b && b.payload.startsWith('cb:b:r:'));
    expect(release).toHaveLength(BUSY_RELEASE_BUTTONS_MAX);
    expect(release[0]!.text).toBe('Освободить Кутха: 01.11.2026');
    expect(s.text).toContain(`Кнопки — у первых ${BUSY_RELEASE_BUTTONS_MAX} отрезков`);
  });

  it('строка меню жилья — «Заявки», «Занято», «Помощь»; «занято» словом — раздел; кнопка `bz` только у жилья; «Ещё» жилья — «Занято»', () => {
    expect(partnerMenu({ partnerId: PARTNER, category: 'stay', slug: null })?.map((b) => [b.text, b.payload]))
      .toEqual([['Заявки', 'rm:st:in'], ['Занято', 'rm:st:bz'], ['Помощь', 'rm:st:hp']]);
    expect(parseRoleMenuPress('rm:st:bz')).toEqual({ role: 'stay', action: 'busy' });
    expect(parseRoleMenuPress('rm:op:bz')).toBeNull();
    expect(parseRoleMenuPress('rm:tf:bz')).toBeNull();
    expect(isCabinetSection('busy')).toBe(true);
    expect(roleMenuAsk('Занято')).toBe('busy');
    expect(roleMenuAsk('что занято?')).toBe('busy');
    expect(roleMenuAsk('занято с 5 по 9 ноября')).toBeNull();
    const more = moreScreen({
      partnerId: PARTNER, role: 'stay', seat: 'owner', bookingActions: false, leadActions: false, operatorAnswers: false, sellsTours: false, summary: false,
    }, 'https://vedarai.ru');
    expect(more.rows.flat().some((b) => 'payload' in b && b.payload === 'cb:b')).toBe(true);
  });
});

describe('гость', () => {
  it('занятые даты карточки: ночи объекта без номеров добавляются к формуле номеров', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: ACC, is_public: true }] })
      .mockResolvedValueOnce({ rows: [{ date: '2026-11-05' }, { date: '2026-11-06' }] });
    const { GET } = await import('@/app/api/accommodations/[id]/blocked-dates/route');
    const res = await GET(
      new Request(`http://l/api/accommodations/${ACC}/blocked-dates?startDate=2026-11-01&endDate=2026-11-30`) as never,
      { params: Promise.resolve({ id: ACC }) },
    );
    const body = await res.json();
    expect(body.data.blockedDates).toEqual(['2026-11-05', '2026-11-06']);
    const sql = String(dbQuery.mock.calls[1]![0]);
    expect(sql).toContain('UNION');
    expect(sql).toContain(objectBusyNightsSql('$1::uuid', '$2::date', '($3::date + 1)'));
    expect(objectBusyNightsSql('a.id', '$1::date', '$2::date')).toContain('av.room_id IS NULL AND av.is_blocked = TRUE');
  });

  it('заявка на закрытые даты не пишется: исход busy с датами, INSERT не зовётся', async () => {
    pool
      .mockResolvedValueOnce({ rows: [{ name: 'Кутха', price_from: null, price_to: null, max_chat_id: null, telegram_chat_id: null }] })
      .mockResolvedValueOnce({ rows: [{ night: '2026-11-06' }] });
    const { submitStayRequest } = await import('@/lib/stay/stay-request-service');
    const r = await submitStayRequest({
      accommodationId: ACC, checkIn: '2026-11-05', checkOut: '2026-11-08', nights: 3, guests: 2, guestName: 'Анна', guestPhone: '+79990001122',
      comment: null, consent: { at: new Date().toISOString(), ip: '203.0.113.9', source: 'stay-request', version: 'v' } as never, door: 'form',
    });
    expect(r).toEqual({ ok: false, reason: 'busy', busyDates: ['2026-11-06'] });
    expect(pool).toHaveBeenCalledTimes(2);
    expect(String(pool.mock.calls[1]![0])).toContain('av.room_id IS NULL AND av.is_blocked = TRUE');
    expect(pool.mock.calls[1]![1]).toEqual([ACC, '2026-11-05', '2026-11-08']);
  });

  it('каталог по датам: объект без номеров остаётся, если хозяин не закрыл ни одну ночь окна, и помечен dates_by_owner', async () => {
    dbQuery.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*) as total')) return Promise.resolve({ rows: [{ total: '0' }] });
      return Promise.resolve({ rows: [] });
    });
    const { GET } = await import('@/app/api/accommodations/route');
    const res = await GET(new Request('http://l/api/accommodations?check_in=2026-11-05&check_out=2026-11-08') as never);
    expect(res.status).toBe(200);
    const sql = String(dbQuery.mock.calls[0]![0]);
    expect(sql).toContain('HAVING bool_and(NOT rn.blocked AND rn.free_units > 0)');
    expect(sql).toMatch(/OR \(\s*NOT EXISTS \(SELECT 1 FROM accommodation_rooms r WHERE r\.accommodation_id = a\.id AND r\.is_active = TRUE\)\s*AND NOT EXISTS \(SELECT av\.date::text AS night/);
    const listSql = String(dbQuery.mock.calls[1]![0]);
    expect(listSql).toContain('AS dates_by_owner');
  });
});
