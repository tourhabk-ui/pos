/**
 * «Регистрация в МЧС» в чате (слово владельца 10.11) — вызовом.
 *
 * Держит:
 *  - туристу — правило, срок и ссылки из одного источника фактов
 *    (lib/safety/mchs-registration), без обещания «зарегистрировано»;
 *  - три исхода о требовании маршрута: `false` в базе — «не отмечено», а не
 *    «не нужна»; маршрута у тура нет — «не знаем» (§4.0);
 *  - текст выезда без контактов не несёт имён и телефонов, а запрос без
 *    флага их и не выбирает (ПД туристов — только MAX);
 *  - отказ базы — отказ, а не «выездов нет»;
 *  - кнопки разбираются обратно, испорченная дата — не кнопка.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MCHS_CHAT_BUTTON, MCHS_CHAT_TEXT, MCHS_CONTACTS_MAX, MCHS_LIST_MAX, MCHS_REQUIREMENT_TEXT, MCHS_WHO_SUBMITS,
  mchsDeadlineOf, mchsDepartureLines, mchsGroupText, mchsRequirementOf, mchsTouristLinks, mchsTouristText,
  type MchsDeparture, type MchsGroup,
} from '@/lib/safety/mchs-chat';
import {
  MCHS_AFTER_RETURN, MCHS_CHANNELS, MCHS_DEADLINE_SHORT, MCHS_ONLINE_FORM_URL, MCHS_PHONES, MCHS_REQUIRED_DATA,
} from '@/lib/safety/mchs-registration';
import { CABINET_PAYLOAD_MAX_BYTES, cabinetPayload, parseCabinetPress } from '@/lib/chat-cabinet/payload';
import { mchsGroupScreen, mchsListScreen } from '@/lib/chat-cabinet/mchs-screens';
import { loadMchsDepartures, loadMchsGroup, mchsGroupSql } from '@/lib/chat-cabinet/mchs-store';

/** 10.11.2026 12:00 по Камчатке. */
const NOW = Date.UTC(2026, 10, 10, 0, 0);
const PID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://vedarai.ru';

const departure = (over: Partial<MchsDeparture> = {}): MchsDeparture => ({
  date: '2027-07-19', endDate: '2027-07-22', tourId: '81', title: 'Курильское озеро, 4 дня',
  people: 6, bookings: 3, routeTitle: 'Курильское озеро', required: true, mchsPhone: null, ...over,
});

const group = (over: Partial<MchsGroup> = {}): MchsGroup => ({
  ...departure(),
  contacts: [{ name: 'Тест <b>', phone: '+70000000000', participants: 2 }, { name: null, phone: null, participants: 4 }],
  ...over,
});

const payloads = (rows: Array<Array<{ payload?: string; url?: string }>>) => rows.flat().map((b) => b.payload ?? b.url);

describe('турист: правило, срок и ссылки', () => {
  it('срок, перечень данных и каналы — те же, что в источнике фактов', () => {
    const text = mchsTouristText();
    expect(text).toContain(`<b>${MCHS_CHAT_BUTTON}</b>`);
    expect(text).toContain(MCHS_DEADLINE_SHORT);
    for (const d of MCHS_REQUIRED_DATA) expect(text).toContain(d);
    for (const c of MCHS_CHANNELS) expect(text).toContain(c.detail);
    expect(text).toContain('В беде — 112.');
  });

  it('звонок после возвращения — первым после заголовка; телефоны ГУ с назначением (памятка ГУ, 10.11)', () => {
    const text = mchsTouristText();
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    expect(lines[1]).toBe(`<b>${MCHS_AFTER_RETURN}</b>`);
    for (const p of MCHS_PHONES) expect(text).toContain(`${p.phone} — ${p.purpose}`);
  });

  it('говорит, кто подаёт заявку, и не обещает регистрацию от имени Ведара', () => {
    const text = mchsTouristText();
    expect(text).toContain(MCHS_WHO_SUBMITS);
    expect(text).toContain('группу регистрирует он');
    // Запрет: Ведар не утверждает, что человек или группа зарегистрированы.
    expect(text).not.toMatch(/вы зарегистрированы|группа зарегистрирована|заявка (подана|принята)/i);
  });

  it('две ссылки: официальная форма и страница сбора данных на сайте', () => {
    expect(mchsTouristLinks(`${BASE}/`)).toEqual([
      { text: 'Форма МЧС', url: MCHS_ONLINE_FORM_URL },
      { text: 'Собрать данные', url: `${BASE}/register` },
    ]);
  });
});

describe('требование маршрута — три исхода', () => {
  it('false в базе — «не отмечено», маршрута нет — «в записи нет»', () => {
    expect(mchsRequirementOf(true, true)).toBe('required');
    expect(mchsRequirementOf(true, false)).toBe('not_marked');
    expect(mchsRequirementOf(true, null)).toBe('not_marked');
    expect(mchsRequirementOf(false, null)).toBe('no_route');
    expect(MCHS_REQUIREMENT_TEXT.not_marked).toContain('не значит, что регистрация не нужна');
    expect(MCHS_REQUIREMENT_TEXT.no_route).toContain('в записи Ведара нет');
  });
});

describe('срок по выезду', () => {
  it('далёкий выезд — выдерживается; через три дня — уже нет', () => {
    expect(mchsDeadlineOf('2027-07-19', NOW).verdict).toBe('in_time');
    const late = mchsDeadlineOf('2026-11-13', NOW);
    expect(late.verdict).toBe('too_late');
    expect(late.text).toContain('уже не выдержать');
  });

  it('день считается по Камчатке: утром вторника там — в UTC ещё понедельник, лишнего рабочего дня нет', () => {
    // 10.11 08:00 по Камчатке = 09.11 20:00 UTC. До 24.11 от вторника 10.11 — 9 рабочих дней.
    const morning = Date.UTC(2026, 10, 9, 20, 0);
    expect(mchsDeadlineOf('2026-11-24', morning).verdict).toBe('too_late');
    expect(mchsDeadlineOf('2026-11-24', morning).text).toContain('До выхода 9 раб. дн.');
  });

  it('строка выезда называет дату, тур, людей, требование и срок', () => {
    const [head, tail] = mchsDepartureLines(departure({ title: 'Тур <i>' }), NOW);
    expect(head).toBe('<b>19.07</b> · Тур &lt;i&gt; — 6 чел.');
    expect(tail).toContain(MCHS_REQUIREMENT_TEXT.required);
    expect(tail).toContain('выдерживается');
  });
});

describe('текст выезда для формы МЧС', () => {
  it('с контактами — имена и телефоны экранированы, остальных участников нет в записи', () => {
    const text = mchsGroupText(group(), NOW);
    expect(text).toContain('Даты: 19.07.2027 — 22.07.2027');
    expect(text).toContain('Маршрут: Курильское озеро (тур «Курильское озеро, 4 дня»)');
    expect(text).toContain('Группа: 6 чел., броней — 3');
    expect(text).toContain('1. Тест &lt;b&gt;, тел. +70000000000, 2 чел.');
    expect(text).toContain('2. имя не записано, 4 чел.');
    expect(text).toContain('Имён остальных участников в записи Ведара нет.');
    expect(text).toContain('заполните в форме МЧС');
    expect(text).toContain(MCHS_WHO_SUBMITS);
  });

  it('без контактов — ни имён, ни телефонов', () => {
    const text = mchsGroupText(group({ contacts: null }), NOW);
    expect(text).not.toContain('Тест');
    expect(text).not.toContain('+7');
    expect(text).not.toContain('Контактные лица');
    expect(text).toContain('Группа: 6 чел., броней — 3');
  });

  it('контактных лиц больше предела — показаны первые, остаток назван числом', () => {
    const many = Array.from({ length: MCHS_CONTACTS_MAX + 3 }, (_, i) => ({ name: `Тест ${i + 1}`, phone: null, participants: 1 }));
    const text = mchsGroupText(group({ contacts: many }), NOW);
    expect(text).toContain(`${MCHS_CONTACTS_MAX}. Тест ${MCHS_CONTACTS_MAX}, 1 чел.`);
    expect(text).not.toContain(`Тест ${MCHS_CONTACTS_MAX + 1},`);
    expect(text).toContain('…и ещё 3 — в кабинете на сайте.');
  });

  it('маршрут не привязан — так и сказано, телефон МЧС маршрута — когда записан', () => {
    const none = mchsGroupText(group({ routeTitle: null, required: null, contacts: null }), NOW);
    expect(none).toContain('в записи Ведара не привязан');
    expect(none).toContain(MCHS_REQUIREMENT_TEXT.no_route);
    expect(none).not.toContain('Телефон МЧС');
    expect(mchsGroupText(group({ mchsPhone: '8 (4152) 00-00-00' }), NOW)).toContain('Телефон МЧС из записи маршрута: 8 (4152) 00-00-00.');
  });
});

describe('кнопки кабинета', () => {
  it('список и выезд разбираются обратно; испорченная дата — не кнопка', () => {
    expect(parseCabinetPress(cabinetPayload.mchs())).toEqual({ kind: 'mchs' });
    expect(cabinetPayload.mchsGroup('81', '2027-07-19')).toBe('cb:mc:81:20270719');
    expect(parseCabinetPress('cb:mc:81:20270719')).toEqual({ kind: 'mchs_group', tourId: '81', date: '2027-07-19' });
    expect(parseCabinetPress('cb:mc:81:20270231')).toBeNull();
    expect(parseCabinetPress('cb:mc:81')).toBeNull();
    // «Ещё» (`cb:m`) кнопкой МЧС не стало и наоборот.
    expect(parseCabinetPress('cb:m')).toEqual({ kind: 'more' });
    expect(Buffer.byteLength(cabinetPayload.mchsGroup('9'.repeat(18), '2027-07-19'))).toBeLessThanOrEqual(CABINET_PAYLOAD_MAX_BYTES);
  });
});

describe('экраны', () => {
  it('база не ответила — отказ и форма МЧС, а не «выездов нет»', () => {
    const s = mchsListScreen({ departures: null, nowMs: NOW });
    expect(s.failed).toBe(true);
    expect(s.text).toContain(MCHS_CHAT_TEXT.listFailed);
    expect(s.text).not.toContain(MCHS_CHAT_TEXT.listEmpty);
    expect(payloads(s.rows)).toContain(MCHS_ONLINE_FORM_URL);
  });

  it('выездов нет — так и сказано, форма доступна', () => {
    const s = mchsListScreen({ departures: [], nowMs: NOW });
    expect(s.failed).toBeUndefined();
    expect(s.text).toContain(MCHS_CHAT_TEXT.listEmpty);
    expect(payloads(s.rows)).toContain(MCHS_ONLINE_FORM_URL);
  });

  it('список — без имён, кнопка на выезд; сверх восьми — названо, сколько не показано', () => {
    const ten = Array.from({ length: 10 }, (_, i) => departure({ tourId: String(100 + i), date: `2027-07-${String(10 + i).padStart(2, '0')}` }));
    const s = mchsListScreen({ departures: ten, nowMs: NOW });
    expect(s.pd).toBe(false);
    const group_buttons = payloads(s.rows).filter((p) => String(p).startsWith('cb:mc:'));
    expect(group_buttons).toHaveLength(MCHS_LIST_MAX);
    expect(group_buttons[0]).toBe('cb:mc:100:20270710');
    expect(s.text).toContain(`Показаны ближайшие ${MCHS_LIST_MAX} из 10`);
    expect(s.text).toContain(MCHS_WHO_SUBMITS);
  });

  it('выезд с контактами — экран с ПД; без контактов — нет, и названо, где состав', () => {
    const withPd = mchsGroupScreen({ group: group(), role: 'operator', base: BASE, nowMs: NOW });
    expect(withPd.pd).toBe(true);
    expect(withPd.text).toContain('+70000000000');
    const plain = mchsGroupScreen({ group: group({ contacts: null }), role: 'guide', base: BASE, nowMs: NOW });
    expect(plain.pd).toBe(false);
    expect(plain.text).not.toContain('+7');
    expect(plain.text).toContain(MCHS_CHAT_TEXT.groupNoContactsTelegram);
    expect(payloads(plain.rows)).toEqual(expect.arrayContaining([MCHS_ONLINE_FORM_URL, `${BASE}/hub/guide`, 'cb:mc']));
  });
});

describe('чтение из базы', () => {
  it('без флага контактов запрос не выбирает имя и телефон туриста', async () => {
    expect(mchsGroupSql(false)).not.toMatch(/tourist_name|tourist_phone/);
    expect(mchsGroupSql(true)).toMatch(/b\.tourist_name, b\.tourist_phone/);
    const query = vi.fn(async () => ({ rows: [
      { participants: 2, end_d: '2027-07-22', title: 'Тур', route_title: null, required: null, mchs_phone: null },
      { participants: '4', end_d: '2027-07-20', title: 'Тур', route_title: null, required: null, mchs_phone: null },
    ] }));
    const g = await loadMchsGroup(PID, '81', '2027-07-19', false, { query } as never);
    expect(String(query.mock.calls[0]?.[0])).not.toMatch(/tourist_name|tourist_phone/);
    expect(query.mock.calls[0]?.[1]).toEqual([PID, '81', '2027-07-19']);
    expect(g).toMatchObject({ people: 6, bookings: 2, endDate: '2027-07-22', contacts: null });
  });

  it('с флагом — контактные лица по броням; броней нет — null', async () => {
    const query = vi.fn(async () => ({ rows: [
      { tourist_name: 'Тест', tourist_phone: '+70000000000', participants: 2, end_d: '2027-07-19', title: 'Тур', route_title: 'Маршрут', required: true, mchs_phone: null },
    ] }));
    const g = await loadMchsGroup(PID, '81', '2027-07-19', true, { query } as never);
    expect(g).toMatchObject({ contacts: [{ name: 'Тест', phone: '+70000000000', participants: 2 }], routeTitle: 'Маршрут', required: true });
    expect(await loadMchsGroup(PID, '81', '2027-07-19', true, { query: vi.fn(async () => ({ rows: [] })) } as never)).toBeNull();
  });

  it('отказ базы — «failed» и строка в лог, не пустой список', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = { query: vi.fn(async () => { throw Object.assign(new Error('x'), { code: '42703' }); }) };
    expect(await loadMchsDepartures(PID, '2026-11-10', '2027-01-09', boom as never)).toBe('failed');
    expect(await loadMchsGroup(PID, '81', '2027-07-19', false, boom as never)).toBe('failed');
    expect(log.mock.calls.some((c) => String(c[0]).includes('SQLSTATE 42703'))).toBe(true);
    log.mockRestore();
  });

  it('выезды — числа и факты маршрута, без имён', async () => {
    const query = vi.fn(async () => ({ rows: [
      { d: '2027-07-19', end_d: '2027-07-22', tour_id: '81', title: 'Тур', people: '6', n: '3', route_title: 'Маршрут', required: false, mchs_phone: null },
    ] }));
    const list = await loadMchsDepartures(PID, '2026-11-10', '2027-01-09', { query } as never);
    expect(list).toEqual([departure({ title: 'Тур', routeTitle: 'Маршрут', required: false })]);
    expect(String(query.mock.calls[0]?.[0])).not.toMatch(/tourist_name|tourist_phone/);
  });
});

describe('кабинет: снятие с контроля после возвращения (памятка ГУ, 10.11)', () => {
  it('список выездов и экран выезда начинаются со звонка в ЦУКС после возвращения', () => {
    const list = mchsListScreen({ departures: [departure()], nowMs: NOW });
    expect(list.text).toContain(MCHS_AFTER_RETURN);
    const one = mchsGroupScreen({ group: group(), role: 'operator', base: BASE, nowMs: NOW });
    expect(one.text.indexOf(MCHS_AFTER_RETURN)).toBeLessThan(one.text.indexOf('Курильское озеро'));
  });

  it('в текст для формы МЧС эта строка не попадает: его переносят в бланк', () => {
    expect(mchsGroupText(group(), NOW)).not.toContain(MCHS_AFTER_RETURN);
  });
});
