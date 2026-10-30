/**
 * Кабинет в чате (решение владельца 30.10, «всё сразу + Telegram»): форма
 * кнопок и экраны — вызовом, на граничных данных.
 *
 * Что держит:
 *  - каждая кнопка кабинета разбирается обратно в то же действие и влезает в
 *    64 байта callback_data Telegram; чужой и испорченный payload — null;
 *  - Telegram не получает ни имени, ни телефона, ни почты клиента и ни
 *    заголовка задачи — ни в тексте, ни в подписи кнопки, ни в payload, на
 *    любом экране, собранном для Telegram (данные — с ПД во всех полях);
 *  - MAX получает подпись клиента «Анна П.» и телефон кнопкой «Скопировать»
 *    только там, где экран помечен `pd: true`;
 *  - карточка предмета ставит кнопки ответа тому, кому они включены:
 *    туроператору — «Подтвердить» / «Отклонить» под бронью и «Принять» …
 *    «Свяжусь сам» под заявкой, гиду со своими турами — «Связался» …
 *    «Отказ», остальным — ссылку, где ответить;
 *  - всё, что ввели люди, экранировано; строка кабинета — последней.
 */
import { describe, it, expect } from 'vitest';
import {
  CABINET_PAYLOAD_MAX_BYTES, INBOX_KIND_CODE, cabinetPayload, cabinetPressEdits, isCabinetPayload, parseCabinetPress,
} from '@/lib/chat-cabinet/payload';
import {
  FLEET_TEXT, canMoveToTomorrow, clientCardScreen, clientsScreen, contactResultScreen, dueWords, fleetScreen, inboxScreen,
  itemCardScreen, kamchatkaMorning, moreScreen, searchResultsScreen, tasksScreen, digestScreen, digestSlotOfHour, MEMBER_ANSWER_LINE,
  type CabinetPartner, type CabinetScreen,
} from '@/lib/chat-cabinet/screens';
import { maxCabinetRows, telegramCabinetKeyboard } from '@/lib/chat-cabinet/render';
import { formatRub } from '@/lib/transfers/charter-format';
import { bookingPressPayload, leadPressPayload } from '@/lib/bookings/chat-owner-press';
import { INBOX_KINDS } from '@/lib/crm/inbox-kinds';
import type { Inbox, InboxItem } from '@/lib/crm/inbox';
import type { TaskItem } from '@/lib/crm/tasks';
import type { ContactCard, ContactListItem } from '@/lib/crm/contact-queries';

const BASE = 'https://vedarai.ru';
const UUID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const CONTACT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NAME = 'Анна Петрова';
const PHONE = '+79140001122';
const EMAIL = 'anna@example.com';
/** Всё, чего в Telegram быть не должно. */
const PD = [NAME, 'Петрова', PHONE, '79140001122', EMAIL, 'Перезвонить Анне'];
/** 30.10 12:00 по Камчатке. */
const NOW = Date.UTC(2026, 9, 30, 0, 0);

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    kind: 'operator_booking', id: '501', created_at: '2026-10-29T00:00:00.000Z', title: 'Горелый <x>',
    date: '2026-11-05', people: 2, contact_id: CONTACT, contact_name: NAME, waiting_minutes: 190, ...over,
  };
}

function inbox(items: InboxItem[], over: Partial<Inbox> = {}): Inbox {
  return {
    category: 'operator', items, failed: [], chat: { state: 'none' }, not_here: [],
    response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true }, ...over,
  };
}

function partner(over: Partial<CabinetPartner> = {}): CabinetPartner {
  return {
    partnerId: '11111111-1111-4111-8111-111111111111', role: 'operator', seat: 'owner', bookingActions: true, leadActions: false,
    operatorAnswers: true, sellsTours: true, summary: false, ...over,
  };
}

function task(over: Partial<TaskItem> = {}): TaskItem {
  return {
    id: UUID, title: 'Перезвонить Анне', details: null, due_at: '2026-10-30T03:00:00.000Z', done_at: null,
    contact: { id: CONTACT, display_name: NAME }, created_at: '2026-10-29T00:00:00.000Z', reminder: null, ...over,
  };
}

function contact(over: Partial<ContactListItem> = {}): ContactListItem {
  return {
    id: CONTACT, display_name: NAME, phone: PHONE, email: EMAIL, tags: [], origin: 'operator_booking',
    first_seen_at: '2026-10-01T00:00:00.000Z', last_activity_at: '2026-10-29T00:00:00.000Z',
    consent_recorded: true, sources_count: 1, ...over,
  };
}

const payloads = (s: CabinetScreen) => s.rows.flat().flatMap((b) => ('payload' in b ? [b.payload] : []));
const texts = (s: CabinetScreen) => s.rows.flat().map((b) => b.text);
const NAV = ['cb:i', 'cb:t', 'cb:c', 'cb:m'];

function noPd(where: string, value: unknown): void {
  const json = JSON.stringify(value);
  for (const v of PD) expect(json, `${where}: ${v}`).not.toContain(v);
}

describe('кнопки кабинета: форма', () => {
  it('каждая сборка разбирается обратно в то же действие и влезает в 64 байта', () => {
    const forms: Array<[string, unknown]> = [
      [cabinetPayload.more(), { kind: 'more' }],
      [cabinetPayload.openInbox(), { kind: 'inbox', page: 0 }],
      [cabinetPayload.openTasks(), { kind: 'tasks', page: 0 }],
      [cabinetPayload.inbox(), { kind: 'inbox', page: 0 }],
      [cabinetPayload.inbox(3), { kind: 'inbox', page: 3 }],
      [cabinetPayload.tasks(), { kind: 'tasks', page: 0 }],
      [cabinetPayload.tasks(2), { kind: 'tasks', page: 2 }],
      [cabinetPayload.taskDone(UUID), { kind: 'task_done', taskId: UUID }],
      [cabinetPayload.taskTomorrow(UUID), { kind: 'task_tomorrow', taskId: UUID }],
      [cabinetPayload.clients(), { kind: 'clients', page: 0 }],
      [cabinetPayload.clients(4), { kind: 'clients', page: 4 }],
      [cabinetPayload.client(CONTACT), { kind: 'client', contactId: CONTACT }],
      [cabinetPayload.search(), { kind: 'search' }],
      [cabinetPayload.searchCancel(), { kind: 'search_cancel' }],
      [cabinetPayload.touch('reached', CONTACT), { kind: 'touch', outcome: 'reached', contactId: CONTACT }],
      [cabinetPayload.touch('missed', CONTACT), { kind: 'touch', outcome: 'missed', contactId: CONTACT }],
      [cabinetPayload.touch('agreed', CONTACT), { kind: 'touch', outcome: 'agreed', contactId: CONTACT }],
      [cabinetPayload.remind('hour', CONTACT), { kind: 'remind', when: 'hour', contactId: CONTACT }],
      [cabinetPayload.remind('tomorrow', CONTACT), { kind: 'remind', when: 'tomorrow', contactId: CONTACT }],
      [cabinetPayload.remind('days3', CONTACT), { kind: 'remind', when: 'days3', contactId: CONTACT }],
      [cabinetPayload.digest(), { kind: 'digest' }],
      [cabinetPayload.openDigest(), { kind: 'digest' }],
      [cabinetPayload.digestSet('morning'), { kind: 'digest_set', mode: 'morning' }],
      [cabinetPayload.digestSet('day'), { kind: 'digest_set', mode: 'day' }],
      [cabinetPayload.digestSet('evening'), { kind: 'digest_set', mode: 'evening' }],
      [cabinetPayload.digestSet('off'), { kind: 'digest_set', mode: 'off' }],
      [cabinetPayload.fleet(), { kind: 'fleet' }],
      [cabinetPayload.vehicleActive(UUID, true), { kind: 'vehicle_active', vehicleId: UUID, active: true }],
      [cabinetPayload.vehicleActive(UUID, false), { kind: 'vehicle_active', vehicleId: UUID, active: false }],
      [cabinetPayload.carrierSummary(), { kind: 'carrier_summary' }],
    ];
    for (const kind of INBOX_KINDS) {
      forms.push([cabinetPayload.item(kind, UUID), { kind: 'item', item: kind, id: UUID }]);
      forms.push([cabinetPayload.item(kind, '123456789012345678'), { kind: 'item', item: kind, id: '123456789012345678' }]);
    }
    for (const [p, want] of forms) {
      expect(isCabinetPayload(p), p).toBe(true);
      expect(parseCabinetPress(p), p).toEqual(want);
      expect(Buffer.byteLength(p), p).toBeLessThanOrEqual(CABINET_PAYLOAD_MAX_BYTES);
    }
    // Коды видов не повторяются: иначе карточка открыла бы чужой вид.
    expect(new Set(Object.values(INBOX_KIND_CODE)).size).toBe(INBOX_KINDS.length);
    // Регистр uuid не важен.
    expect(parseCabinetPress(`cb:c:${CONTACT.toUpperCase()}`)).toEqual({ kind: 'client', contactId: CONTACT });
  });

  it('чужой и испорченный payload — не кнопка кабинета', () => {
    for (const bad of [
      'cb:', 'cb:q', 'cb:i:x', 'cb:i:100', 'cb:o:zz:501', 'cb:o:ob:', 'cb:o:ob:5o1', `cb:d:${UUID}x`, 'cb:d:501',
      'cb:k:q:' + CONTACT, 'cb:r:x:' + CONTACT, 'cb:c:not-a-uuid', 'cb:l:', 'rm:op:in', 'tk:d:' + UUID,
      'cb:g:x', 'cb:g:', 'cb:g:mm', 'cb:n:x',
      'cb:v:', 'cb:v:q:' + UUID, 'cb:v:a:501',
    ]) {
      expect(parseCabinetPress(bad), bad).toBeNull();
    }
    expect(isCabinetPayload('rm:op:in')).toBe(false);
  });

  it('кнопки под напоминанием и сводкой (cb:n:) сообщение не правят — остальные правят', () => {
    expect(cabinetPressEdits(cabinetPayload.openInbox())).toBe(false);
    expect(cabinetPressEdits(cabinetPayload.openTasks())).toBe(false);
    expect(cabinetPressEdits(cabinetPayload.openDigest())).toBe(false);
    expect(cabinetPressEdits(cabinetPayload.digest())).toBe(true);
    for (const p of [cabinetPayload.inbox(), cabinetPayload.tasks(1), cabinetPayload.client(CONTACT), cabinetPayload.more()]) {
      expect(cabinetPressEdits(p), p).toBe(true);
    }
  });
});

describe('«Входящие»', () => {
  it('без имени и телефона; номер — кнопка карточки; экранировано; строка кабинета последней', () => {
    const lead = item({ kind: 'lead', id: UUID, title: `Толбачик, звоните ${PHONE}`, date: `июль, ${EMAIL}`, contact_name: NAME });
    for (const channel of ['max', 'telegram'] as const) {
      const s = inboxScreen(inbox([item(), lead]), 0);
      expect(s.pd).toBe(false);
      expect(s.text).toContain('Ждут ответа: 2.');
      expect(s.text).toContain('1. Бронь тура · Горелый &lt;x&gt; · 2026-11-05 · 2 чел · ждёт 3 ч');
      expect(s.text).toContain('2. Заявка на подбор');
      noPd(`список ${channel}`, s);
      expect(payloads(s)).toEqual([cabinetPayload.item('operator_booking', '501'), cabinetPayload.item('lead', UUID), ...NAV]);
      expect(texts(s)[0]).toBe('1. Бронь тура · 05.11');
    }
  });

  it('не прочитался вид — назван и не выдан за «нет»; страницы листаются', () => {
    const failed = inboxScreen(inbox([], { failed: ['lead'] }), 0);
    expect(failed.text).toContain('Не прочиталось: Заявка на подбор. Это не «таких нет».');
    expect(failed.text).not.toContain('Ждут ответа: нет');
    const many = Array.from({ length: 8 }, (_, i) => item({ id: String(600 + i) }));
    const p0 = inboxScreen(inbox(many), 0);
    expect(payloads(p0)).toContain('cb:i:1');
    expect(p0.text).toContain('Страница 1 из 2.');
    const p1 = inboxScreen(inbox(many), 1);
    expect(payloads(p1)).toContain('cb:i');
    expect(payloads(p1).filter((p) => p.startsWith('cb:o:'))).toHaveLength(2);
    // Страница за концом — последняя, а не пустая.
    expect(inboxScreen(inbox(many), 9).text).toContain('Страница 2 из 2.');
  });
});

describe('карточка предмета', () => {
  it('туроператор: под бронью «Подтвердить» и «Отклонить», под заявкой — четыре ответа, «Связался» нет', () => {
    const b = itemCardScreen({ item: item(), partner: partner(), channel: 'max', base: BASE });
    expect(payloads(b)).toEqual(expect.arrayContaining([bookingPressPayload('confirm', '501'), bookingPressPayload('cancel', '501')]));
    expect(b.text).toContain('бронь меняется только после «Да»');
    const l = itemCardScreen({ item: item({ kind: 'lead', id: UUID }), partner: partner(), channel: 'max', base: BASE });
    expect(payloads(l)).toEqual(expect.arrayContaining([`ia:a:l:${UUID}`, `ia:n:l:${UUID}`, `ia:c:l:${UUID}`, `ia:m:l:${UUID}`]));
    expect(payloads(l).some((p) => p.startsWith('ld:'))).toBe(false);
    // Переписка с клиентом по заявке — в MAX.
    expect(payloads(l)).toContain(`lq:o:${UUID}`);
  });

  it('гид со своими турами — «Связался», «Договорились», «Отказ»; кому кнопки не включены — ссылка, где ответить', () => {
    const guide = partner({ role: 'guide', leadActions: true, operatorAnswers: false });
    const l = itemCardScreen({ item: item({ kind: 'lead', id: UUID }), partner: guide, channel: 'max', base: BASE });
    expect(payloads(l)).toEqual(expect.arrayContaining(
      [leadPressPayload('contacted', UUID), leadPressPayload('converted', UUID), leadPressPayload('lost', UUID)],
    ));
    const team = partner({ role: 'guide', bookingActions: false, leadActions: false, operatorAnswers: false, sellsTours: false });
    const b = itemCardScreen({ item: item(), partner: team, channel: 'max', base: BASE });
    expect(payloads(b).some((p) => /^(?:bk|ld|ia):/.test(p))).toBe(false);
    expect(b.text).toContain('Где ответить: Подтвердить или отклонить в разделе «Свои туры».');
    const link = b.rows.flat().find((x) => 'url' in x && x.text === 'Открыть в кабинете');
    expect(link && 'url' in link ? link.url : '').toBe(`${BASE}/hub/guide/own`);
  });

  it('жильё: три кнопки ответа в обоих каналах (30.10), «Ответить гостю» в MAX; в Telegram — нет; ссылка на «Входящие», если раздела нет', () => {
    const stay = partner({ role: 'stay', bookingActions: false, operatorAnswers: false, sellsTours: false });
    const req = item({ kind: 'stay_request', id: UUID, title: 'Кутха' });
    const mx = itemCardScreen({ item: req, partner: stay, channel: 'max', base: BASE });
    expect(payloads(mx)).toContain(`sq:o:${UUID}`);
    expect(payloads(mx)).toEqual(expect.arrayContaining([`sa:f:${UUID}`, `sa:b:${UUID}`, `sa:c:${UUID}`]));
    expect(mx.text).toContain('Нажмите одну кнопку');
    const tg = itemCardScreen({ item: req, partner: stay, channel: 'telegram', base: BASE });
    expect(payloads(tg)).toEqual(expect.arrayContaining([`sa:f:${UUID}`, `sa:b:${UUID}`, `sa:c:${UUID}`]));
    expect(payloads(tg).some((p) => p.startsWith('sq:'))).toBe(false);
    const link = tg.rows.flat().find((x) => 'url' in x);
    expect(link && 'url' in link ? link.url : '').toBe(`${BASE}/hub/stay/inbox`);
  });

  it('MAX: подпись клиента и кнопка карточки клиента, экран помечен ПД; Telegram — ни имени, ни кнопки клиента', () => {
    const mx = itemCardScreen({ item: item(), partner: partner(), channel: 'max', base: BASE });
    expect(mx.pd).toBe(true);
    expect(mx.text).toContain('Клиент: Анна П.');
    expect(mx.text).not.toContain('Петрова');
    expect(payloads(mx)).toContain(cabinetPayload.client(CONTACT));
    const tg = itemCardScreen({ item: item(), partner: partner(), channel: 'telegram', base: BASE });
    expect(tg.pd).toBe(false);
    expect(payloads(tg)).not.toContain(cabinetPayload.client(CONTACT));
    noPd('карточка telegram', tg);
    // Звонок и напоминание — в обоих каналах: в них нет имени.
    for (const s of [mx, tg]) {
      expect(payloads(s)).toEqual(expect.arrayContaining([
        cabinetPayload.touch('reached', CONTACT), cabinetPayload.touch('missed', CONTACT), cabinetPayload.touch('agreed', CONTACT),
        cabinetPayload.remind('hour', CONTACT), cabinetPayload.remind('tomorrow', CONTACT), cabinetPayload.remind('days3', CONTACT),
      ]));
      expect(payloads(s).slice(-4)).toEqual(NAV);
    }
    // Клиента у предмета нет — нет и кнопок звонка.
    const none = itemCardScreen({ item: item({ contact_id: null, contact_name: null }), partner: partner(), channel: 'max', base: BASE });
    expect(payloads(none).some((p) => p.startsWith('cb:k:') || p.startsWith('cb:r:'))).toBe(false);
    expect(none.pd).toBe(false);
  });

  it('свободный текст туриста в заявке — без телефона и почты в обоих каналах', () => {
    const lead = item({ kind: 'lead', id: UUID, title: `Толбачик ${PHONE}`, date: `июль ${EMAIL}`, contact_id: null, contact_name: null });
    for (const channel of ['max', 'telegram'] as const) {
      noPd(`заявка ${channel}`, itemCardScreen({ item: lead, partner: partner(), channel, base: BASE }));
    }
  });
});

describe('«Задачи»', () => {
  it('MAX: заголовки, подпись клиента, «Готово» и «На завтра» только сегодняшней и просроченной', () => {
    const later = task({ id: '00000000-0000-4000-8000-000000000002', title: 'Отправить программу', due_at: '2026-11-03T22:00:00.000Z', contact: null });
    const overdue = task({ id: '00000000-0000-4000-8000-000000000003', title: 'Счёт', due_at: '2026-10-29T22:00:00.000Z', contact: null });
    const s = tasksScreen({ tasks: [overdue, task(), later], page: 0, channel: 'max', role: 'operator', base: BASE, nowMs: NOW });
    expect(s.pd).toBe(true);
    expect(s.text).toContain('Открытых: 3 · просрочено: 1 · на сегодня: 1.');
    expect(s.text).toContain('2. Перезвонить Анне — сегодня 15:00 · Анна П.');
    expect(s.text).toContain('1. Счёт — сегодня 10:00, просрочена');
    expect(s.text).toContain('3. Отправить программу — 04.11 10:00');
    expect(payloads(s)).toEqual([
      cabinetPayload.taskDone(overdue.id), cabinetPayload.taskTomorrow(overdue.id),
      cabinetPayload.taskDone(UUID), cabinetPayload.taskTomorrow(UUID),
      cabinetPayload.taskDone(later.id), ...NAV,
    ]);
  });

  it('Telegram: только счёт и ближайший срок — ни заголовка, ни имени, ни кнопки задачи', () => {
    const s = tasksScreen({ tasks: [task()], page: 0, channel: 'telegram', role: 'guide', base: BASE, nowMs: NOW });
    expect(s.pd).toBe(false);
    expect(s.text).toContain('Открытых: 1 · просрочено: 0 · на сегодня: 1.');
    expect(s.text).toContain('Ближайший срок: сегодня 15:00.');
    noPd('задачи telegram', s);
    expect(payloads(s)).toEqual(NAV);
    expect(s.rows.flat().find((b) => 'url' in b)).toEqual({ text: 'Задачи в кабинете', url: `${BASE}/hub/guide/tasks` });
  });

  it('срок по Камчатке: «На завтра» — 10:00 завтрашнего камчатского дня; слова срока', () => {
    expect(kamchatkaMorning(NOW, 1).toISOString()).toBe('2026-10-30T22:00:00.000Z');
    // 23:30 по Камчатке — «завтра» ещё 31.10; 00:30 — уже 01.11 (а по UTC это всё ещё 30.10).
    expect(kamchatkaMorning(Date.UTC(2026, 9, 30, 11, 30), 1).toISOString()).toBe('2026-10-30T22:00:00.000Z');
    expect(kamchatkaMorning(Date.UTC(2026, 9, 30, 12, 30), 1).toISOString()).toBe('2026-10-31T22:00:00.000Z');
    expect(canMoveToTomorrow({ due_at: '2026-10-30T11:59:00.000Z' }, NOW)).toBe(true);
    expect(canMoveToTomorrow({ due_at: '2026-10-30T12:00:00.000Z' }, NOW)).toBe(false);
    expect(dueWords('2026-10-30T22:00:00.000Z', NOW)).toBe('завтра 10:00');
  });
});

describe('«Клиенты» и карточка клиента', () => {
  it('Telegram: только счёт и ссылка — имён и поиска нет; MAX: подписи «Анна П.» и «Найти клиента»', () => {
    const tg = clientsScreen({ items: [contact()], total: 7, page: 0, channel: 'telegram', role: 'stay', base: BASE });
    expect(tg.pd).toBe(false);
    expect(tg.text).toContain('Всего: 7.');
    noPd('клиенты telegram', tg);
    expect(payloads(tg)).toEqual(NAV);
    const mx = clientsScreen({ items: [contact()], total: 7, page: 0, channel: 'max', role: 'stay', base: BASE });
    expect(mx.pd).toBe(true);
    expect(texts(mx)[0]).toBe('Анна П. · 29.10');
    expect(payloads(mx)).toEqual([cabinetPayload.client(CONTACT), cabinetPayload.search(), 'cb:l:1', ...NAV]);
    // Имя, в которое записан телефон, подписью не становится.
    const phoneName = clientsScreen({ items: [contact({ display_name: PHONE })], total: 1, page: 0, channel: 'max', role: 'stay', base: BASE });
    expect(texts(phoneName)[0]).toBe('Клиент без имени · 29.10');
  });

  it('карточка: имя и телефон экранированы, телефон — кнопкой «Скопировать», лента и обращения — свежие', () => {
    const card: ContactCard = {
      id: CONTACT, display_name: 'Анна <b>Петрова</b>', phone: PHONE, email: EMAIL, tags: ['vip<'], notes: null,
      origin: 'operator_booking', has_account: false, consent: null,
      first_seen_at: '2026-10-01T00:00:00.000Z', last_activity_at: '2026-10-29T00:00:00.000Z',
      sources: [{ kind: 'operator_booking', id: '501', occurred_at: '2026-10-28T00:00:00.000Z', title: 'Горелый', date_from: '2026-11-05', date_to: null, status: 'confirmed', people: 2, person_name: NAME }],
      events: [{ id: '1', kind: 'call', actor_kind: 'partner_user', title: 'Звонок: <дозвонился>', details: null, source_kind: null, source_id: null, occurred_at: '2026-10-29T01:00:00.000Z' }],
    };
    const s = clientCardScreen({ card, openTasks: 1, role: 'operator', base: BASE });
    expect(s.pd).toBe(true);
    expect(s.text).toContain('<b>Анна &lt;b&gt;Петрова&lt;/b&gt;</b>');
    expect(s.text).toContain(`Телефон: ${PHONE}`);
    expect(s.text).toContain('Метки: vip&lt;');
    expect(s.text).toContain('• «Горелый» · 05.11 · подтверждена');
    expect(s.text).toContain('• 29.10 Звонок: &lt;дозвонился&gt;');
    expect(s.text).toContain('Открытых задач по клиенту: 1.');
    expect(s.rows[0]).toEqual([{ text: 'Скопировать телефон', copy: PHONE }]);
    expect(payloads(s).slice(-4)).toEqual(NAV);
  });

  it('итог звонка: имя клиента — только в MAX; напоминание предлагается кнопками', () => {
    const tg = contactResultScreen({ text: 'Записал.', contactId: CONTACT, name: NAME, channel: 'telegram', offerRemind: true });
    noPd('итог telegram', tg);
    expect(payloads(tg)).toEqual(expect.arrayContaining([cabinetPayload.remind('hour', CONTACT)]));
    expect(payloads(tg)).not.toContain(cabinetPayload.client(CONTACT));
    const mx = contactResultScreen({ text: 'Записал.', contactId: CONTACT, name: NAME, channel: 'max', offerRemind: false });
    expect(mx.text).toContain('Клиент: Анна П.');
    expect(mx.pd).toBe(true);
    expect(payloads(mx).some((p) => p.startsWith('cb:r:'))).toBe(false);
  });

  it('поиск: запрос экранирован, подписи — «Анна П.»', () => {
    const s = searchResultsScreen({ query: '<анна>', items: [contact()], total: 9 });
    expect(s.text).toContain('<b>Клиенты: «&lt;анна&gt;»</b>');
    expect(s.text).toContain('Найдено: 9, показываю первых 1.');
    expect(texts(s)[0]).toBe('Анна П. · 29.10');
    expect(searchResultsScreen({ query: 'zz', items: [], total: 0 }).pd).toBe(false);
  });
});

describe('«Ещё»', () => {
  it('туроператор — его кабинет; гид со своими турами — «Брони» и «Мои туры»; у всех — сводка, «Помощь» и сайт', () => {
    expect(payloads(moreScreen(partner(), BASE))).toEqual(['opd:tours', 'opd:seats', 'cb:g', 'rm:op:hp', 'sup:new', ...NAV]);
    expect(payloads(moreScreen(partner({ summary: true }), BASE))).toContain('rm:op:sm');
    // У любого гида — расписание, заработок, профиль и отзывы (роль гида, этап 2, 30.10).
    const guideRole = ['cb:s', 'cb:j', 'cb:p', 'cb:a'];
    expect(payloads(moreScreen(partner({ role: 'guide' }), BASE))).toEqual(['rm:gd:bk', 'rm:gd:tr', ...guideRole, 'cb:g', 'rm:gd:hp', ...NAV]);
    expect(payloads(moreScreen(partner({ role: 'guide', sellsTours: false }), BASE))).toEqual([...guideRole, 'cb:g', 'rm:gd:hp', ...NAV]);
    // Перевозчик: «Машины и прайс» (#2862 этап C) — парк и черновики прайса, затем сводка.
    expect(payloads(moreScreen(partner({ role: 'transfer', sellsTours: false }), BASE))).toEqual(['cb:v', 'cb:y', 'cb:g', 'rm:tf:hp', ...NAV]);
    expect(payloads(moreScreen(partner({ role: 'stay', sellsTours: false }), BASE))).toEqual(['cb:g', 'rm:st:hp', ...NAV]);
    const site = moreScreen(partner({ role: 'transfer' }), BASE).rows.flat().find((b) => 'url' in b);
    expect(site).toEqual({ text: 'Кабинет на сайте', url: `${BASE}/hub/carrier` });
    // Кнопка сводки называет нынешнее время; не прочиталось — без слова о времени.
    expect(texts(moreScreen(partner(), BASE, 'evening'))).toContain('Ежедневная сводка: вечером');
    expect(texts(moreScreen(partner(), BASE, 'off'))).toContain('Ежедневная сводка: не присылать');
    expect(texts(moreScreen(partner(), BASE, null))).toContain('Ежедневная сводка');
  });

  it('менеджер команды: в «Ещё» нет кнопок оператора (туры, места, поддержка, помощь, сводка) — только сайт и правило', () => {
    const more = moreScreen(partner({ seat: 'member' }), BASE, 'morning');
    expect(payloads(more)).toEqual(NAV);
    expect(more.text).toContain('Брони подтверждает и отклоняет владелец кабинета');
    expect(more.rows.flat().some((b) => 'url' in b && b.url === `${BASE}/hub/operator`)).toBe(true);
  });
});

describe('менеджер команды — карточка предмета', () => {
  it('без кнопок ответа на бронь и заявку и без переписки с клиентом; звонок и задача — есть', () => {
    const member = partner({ seat: 'member', bookingActions: false, operatorAnswers: false });
    const b = itemCardScreen({ item: item(), partner: member, channel: 'max', base: BASE });
    expect(payloads(b).some((p) => /^(?:bk|ld|ia|oc|lq|sq|rr):/.test(p))).toBe(false);
    expect(b.text).toContain(MEMBER_ANSWER_LINE);
    expect(payloads(b)).toEqual(expect.arrayContaining([cabinetPayload.touch('reached', CONTACT), cabinetPayload.remind('hour', CONTACT)]));
    const l = itemCardScreen({ item: item({ kind: 'lead', id: UUID }), partner: member, channel: 'max', base: BASE });
    expect(payloads(l).some((p) => /^(?:ia|ld|lq):/.test(p))).toBe(false);
    // Даже если флаги кнопок по ошибке включены — место решает.
    const forced = itemCardScreen({ item: item(), partner: partner({ seat: 'member' }), channel: 'max', base: BASE });
    expect(payloads(forced).some((p) => p.startsWith('bk:'))).toBe(false);
  });
});

describe('ежедневная сводка — экран времени', () => {
  it('нынешнее время отмечено; четыре кнопки; «не присылать» говорит, что не приходит', () => {
    const s = digestScreen('day');
    expect(s.text).toContain('Сейчас приходит днём, с 13:00 по Камчатке.');
    expect(payloads(s).slice(0, 4)).toEqual(['cb:g:m', 'cb:g:d', 'cb:g:e', 'cb:g:o']);
    expect(texts(s)).toContain('• Днём, 13:00');
    expect(texts(s)).toContain('Утром, 08:00');
    expect(digestScreen('off').text).toContain('Сейчас сводка не приходит.');
    expect(texts(digestScreen('off'))).toContain('• Не присылать');
  });

  it('окна не пересекаются: каждый час — не больше одного окна, в 12 и ночью — ни одного', () => {
    const slots = Array.from({ length: 24 }, (_, h) => digestSlotOfHour(h));
    expect(slots.slice(8, 12).every((x) => x === 'morning')).toBe(true);
    expect(slots.slice(13, 17).every((x) => x === 'day')).toBe(true);
    expect(slots.slice(18, 22).every((x) => x === 'evening')).toBe(true);
    for (const h of [0, 5, 7, 12, 17, 22, 23]) expect(slots[h], String(h)).toBeNull();
  });
});

describe('«Машины и прайс» перевозчика (#2862 этап C)', () => {
  const PRICE_ID = '7a7a7a7a-1111-4111-8111-7a7a7a7a7a7a';
  const VEHICLE_ID = '5b5b5b5b-2222-4222-8222-5b5b5b5b5b5b';
  const row = {
    id: PRICE_ID, vehicleKind: 'vahtovka' as const, lineKind: 'destination' as const,
    fromText: 'Петропавловск', toText: 'Авачинский <x>', priceRub: 65000, priceNote: null, conditions: null, validYear: 2026, isActive: true,
  };
  const draft = {
    id: UUID, priceId: PRICE_ID, priceRub: 70000, priceNote: null, conditions: null, isActive: null,
    vehicleKind: null, lineKind: null, fromText: null, toText: null, validYear: null,
    status: 'pending' as const, reason: null, createdAt: '2026-10-30T00:00:00Z', moderatedAt: null,
  };
  const vehicle = { id: VEHICLE_ID, kind: 'vahtovka' as const, title: 'КамАЗ <синяя>', seats: 26, notes: null, is_active: true };

  it('машина — кнопка «Снять с линии»; цена с черновиком; экранировано; без ПД; строка кабинета последней', () => {
    const s = fleetScreen({ vehicles: [vehicle], prices: [row], drafts: [draft], base: BASE });
    expect(s.pd).toBe(false);
    expect(s.text).toContain('КамАЗ &lt;синяя&gt;');
    expect(s.text).toContain('Авачинский &lt;x&gt;');
    expect(s.text).toContain(formatRub(65000));
    expect(s.text).toContain(`черновик на модерации: ${formatRub(70000)}`);
    expect(payloads(s)).toEqual([cabinetPayload.vehicleActive(VEHICLE_ID, false), ...NAV]);
    expect(texts(s)).toContain('1. Снять с линии');
    const site = s.rows.flat().find((b) => 'url' in b);
    expect(site).toEqual({ text: 'Прайс на сайте', url: `${BASE}/hub/carrier` });
    noPd('машины и прайс', s);
  });

  it('снятая машина — «Вернуть на линию»; скрытая строка, новая строка и отказ — названы', () => {
    const s = fleetScreen({
      vehicles: [{ ...vehicle, is_active: false }],
      prices: [{ ...row, isActive: false }],
      drafts: [
        { ...draft, id: CONTACT, priceId: null, priceRub: 15000, lineKind: 'extra_day', vehicleKind: 'vahtovka' },
        { ...draft, status: 'rejected', reason: 'не та <цифра>', moderatedAt: '2026-10-30T01:00:00Z' },
      ],
      base: BASE,
    });
    expect(s.text).toContain('снята с линии');
    expect(s.text).toContain('(скрыта с сайта)');
    expect(s.text).toContain(`Новая строка на модерации: Доплата за день на месте (вахтовка) — ${formatRub(15000)}`);
    expect(s.text).toContain('не та &lt;цифра&gt;');
    expect(payloads(s)[0]).toBe(cabinetPayload.vehicleActive(VEHICLE_ID, true));
    expect(texts(s)).toContain('1. Вернуть на линию');
  });

  it('не прочитался парк, прайс или черновики — названо, не «нет»', () => {
    const s = fleetScreen({ vehicles: null, prices: null, drafts: null, base: BASE });
    expect(s.text).toContain(FLEET_TEXT.vehiclesFailed);
    expect(s.text).toContain(FLEET_TEXT.pricesFailed);
    expect(s.text).not.toContain('Машин не записано');
    expect(s.text).not.toContain('Строк прайса нет');
    const empty = fleetScreen({ vehicles: [], prices: [], drafts: [], base: BASE });
    expect(empty.text).toContain('Машин не записано');
    expect(empty.text).toContain('Строк прайса нет');
    expect(payloads(empty)).toEqual(NAV);
  });
});

describe('клавиатуры', () => {
  const rows = [
    [{ text: 'Скопировать телефон', copy: PHONE }],
    [{ text: 'Да', payload: 'cb:i', intent: 'positive' as const }, { text: 'Сайт', url: `${BASE}/hub` }],
  ];
  it('MAX: copy → clipboard, url → link, payload → callback с intent', () => {
    expect(maxCabinetRows(rows)).toEqual([
      [{ type: 'clipboard', text: 'Скопировать телефон', payload: PHONE }],
      [{ type: 'callback', text: 'Да', payload: 'cb:i', intent: 'positive' }, { type: 'link', text: 'Сайт', url: `${BASE}/hub` }],
    ]);
  });
  it('Telegram: кнопки «Скопировать» нет вовсе — её телефон в Telegram не уходит', () => {
    const kb = telegramCabinetKeyboard(rows);
    expect(kb).toEqual({ inline_keyboard: [[{ text: 'Да', callback_data: 'cb:i' }, { text: 'Сайт', url: `${BASE}/hub` }]] });
    noPd('клавиатура telegram', kb);
  });
});
