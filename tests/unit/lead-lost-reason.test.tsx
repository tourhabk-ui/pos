/**
 * «Отказ» по заявке — только с причиной (план «после отказа», этап 3а).
 *
 * До этого этапа «Потерян» в кабинете оператора и «Отказ» у гида закрывали
 * заявку молча: человеку ничего не уходило, а статус читался «отказал или не
 * состоялась». Судится поведением:
 *  - два рода причин и что род решает: отказ продавца — человеку сообщают,
 *    причина на стороне клиента — нет;
 *  - вид заявки для человека и ИИ-агента: отказ продавца — теми же словами,
 *    что кнопка «Отказать» в чате; причина клиента — «по словам оператора»;
 *    причина держится только у закрытой заявки и главнее ответа кнопкой;
 *  - поток двери: «туристу сообщено» говорится по исходу отправки, а не по
 *    факту нажатия;
 *  - экран оператора: «Потерян» открывает выбор причины, а запрос уходит уже с
 *    ней; администратору (не продавец заявки) выбор не показывается.
 * Запись на настоящем PostgreSQL — tests/integration/request-chat.pg.test.ts
 * (сцена «этап 3а»), двери API — tests/unit/lead-lost-reason-routes.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));

import {
  CLIENT_LOST_REASONS, LOST_REASONS, LOST_REASON_GROUPS, LOST_REASON_LABEL, SELLER_LOST_REASONS,
  isLostReason, lostReasonTellsTourist,
} from '@/lib/leads/lost-reason';
import { DECLINE_REASONS, DECLINE_REASON_LABEL } from '@/lib/requests/chat-answer-buttons';
import { buildRequestView, shownAnswerRef, type StatusRow } from '@/lib/mcp/request-status';
import {
  CLIENT_REASON_LINE, NOT_ADDRESSED_LINE, NO_NOTICE_KIND_LINE, closeLeadWithReason,
} from '@/lib/leads/seller-lost-flow';
import type { LeadChangeResult } from '@/lib/leads/owner-lead-status';
import { NOTICE_PRESS_BUDGET_MS } from '@/lib/requests/press-budget';
import LeadDetailClient from '@/app/hub/operator/leads/[id]/_LeadDetailClient';
import { leadOrigin } from '@/lib/leads/origin';

describe('причины: два рода, и род решает, что узнает человек', () => {
  it('отказ продавца — те же причины и подписи, что у кнопки «Отказать» в чате; причины клиента — отдельно', () => {
    expect([...SELLER_LOST_REASONS]).toEqual([...DECLINE_REASONS]);
    for (const r of DECLINE_REASONS) expect(LOST_REASON_LABEL[r]).toBe(DECLINE_REASON_LABEL[r]);
    expect([...CLIENT_LOST_REASONS]).toEqual(['no_contact', 'client_declined']);
    expect([...LOST_REASONS]).toEqual([...DECLINE_REASONS, 'no_contact', 'client_declined']);
    // Сообщение человеку — только об отказе продавца.
    for (const r of SELLER_LOST_REASONS) expect(lostReasonTellsTourist(r), r).toBe(true);
    for (const r of CLIENT_LOST_REASONS) expect(lostReasonTellsTourist(r), r).toBe(false);
    expect(isLostReason('seats')).toBe(true);
    expect(isLostReason('просто так')).toBe(false);
    expect(isLostReason(null)).toBe(false);
  });

  it('выбор на экране покрывает каждую причину ровно один раз, и у каждой группы сказано, что получит турист', () => {
    expect(LOST_REASON_GROUPS.flatMap((g) => [...g.reasons]).sort()).toEqual([...LOST_REASONS].sort());
    const [seller, client] = LOST_REASON_GROUPS;
    expect(seller.note).toMatch(/Туристу уйдёт сообщение/);
    expect(client.note).toMatch(/Туристу ничего не уйдёт/);
    for (const r of seller.reasons) expect(lostReasonTellsTourist(r)).toBe(true);
    for (const r of client.reasons) expect(lostReasonTellsTourist(r)).toBe(false);
  });
});

const NOW = Date.parse('2027-07-01T00:00:00Z');
const LEAD: StatusRow = {
  key_id: 'K', tool_name: 'create_booking_request', lead_id: 'L', seat_request_id: null,
  lead_status: 'lost', route_title: null, booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
  seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null,
  seat_tour: null, seat_booking_id: null, seat_booking_status: null, seat_booking_date: null, seat_booking_participants: null, seat_booking_tour: null,
  lead_consent_at: null, lead_consent_source: null, seat_consent_at: null, seat_consent_source: null,
  stay_request_id: null, stay_accommodation_id: null, stay_name: null, stay_check_in: null, stay_check_out: null, stay_guests: null,
  stay_owner_channel: null, stay_platform_channel: null, stay_delivery_recorded_at: null, stay_consent_at: null, stay_consent_source: null,
  lead_requested_date: '2027-07-15', lead_tour: 'Мутновский', opens_chat: true, lead_addressed: true,
};
const GENERIC = 'Оператор отказал по заявке или она не состоялась.';

describe('вид заявки для человека и ИИ-агента', () => {
  it('отказ продавца — теми же словами, что после кнопки «Отказать», и вид построен из этого закрытия', () => {
    const row = { ...LEAD, lead_lost_reason: 'seats', lead_closed_id: '41' };
    expect(buildRequestView(row, NOW)).toMatchObject({ state: 'declined', human: 'Оператор отказал по заявке. Причина: нет мест.' });
    expect(shownAnswerRef(row)).toEqual({ source: 'closed', id: '41' });
    // Слова те же, что у ответа кнопкой с той же причиной.
    const pressed = buildRequestView({ ...LEAD, lead_answer: 'decline', lead_decline_reason: 'seats', lead_answer_id: '7' }, NOW);
    expect(buildRequestView(row, NOW).human).toBe(pressed.human);
    expect(buildRequestView(row, NOW).next).toBe(pressed.next);
    // После отказа по погоде — то же правило о безопасных вариантах.
    expect(buildRequestView({ ...LEAD, lead_lost_reason: 'weather', lead_closed_id: '41' }, NOW).next).toMatch(/safety_status/);
  });

  it('причина на стороне клиента — «по словам оператора», а не «оператор отказал»', () => {
    const silent = buildRequestView({ ...LEAD, lead_lost_reason: 'no_contact', lead_closed_id: '42' }, NOW);
    expect(silent.state).toBe('declined');
    expect(silent.human).toBe('Оператор закрыл заявку: по его словам, связаться с человеком по телефону из заявки не удалось.');
    expect(silent.next).toMatch(/позвонить оператору сам/);
    const changed = buildRequestView({ ...LEAD, lead_lost_reason: 'client_declined', lead_closed_id: '43' }, NOW);
    expect(changed.human).toBe('Оператор закрыл заявку: по его словам, человек отказался от поездки.');
    expect(changed.next).toMatch(/Если это не так/);
    for (const v of [silent, changed]) expect(v.human).not.toMatch(/отказал по заявке/);
  });

  it('причина держится только у закрытой заявки; бронь главнее; чужой род заявки и мусор её не читают', () => {
    // Заявку вернули в работу, а причина (в жизни её стирает триггер) ещё в строке — вид её не читает.
    const reopened = { ...LEAD, lead_status: 'contacted', lead_lost_reason: 'seats', lead_closed_id: '41' };
    expect(buildRequestView(reopened, NOW).human).not.toMatch(/Причина/);
    expect(shownAnswerRef(reopened)).toBeNull();
    // То же с причиной клиента: «оператор закрыл заявку» о заявке в работе — неправда.
    const reopenedClient = { ...LEAD, lead_status: 'contacted', lead_lost_reason: 'no_contact', lead_closed_id: '42' };
    expect(buildRequestView(reopenedClient, NOW).state).not.toBe('declined');
    expect(buildRequestView(reopenedClient, NOW).human).not.toMatch(/закрыл заявку/);
    expect(shownAnswerRef(reopenedClient)).toBeNull();
    // Бронь по заявке — то, что оператор сделал после: говорит она.
    const booked = { ...LEAD, lead_lost_reason: 'seats', lead_closed_id: '41', booking_status: 'confirmed', booking_date: '2027-07-15' };
    expect(buildRequestView(booked, NOW).state).toBe('confirmed');
    expect(shownAnswerRef(booked)).toBeNull();
    // Заявка на машину: у неё свой ответ и свои слова.
    const charter = { ...LEAD, tool_name: 'request_charter', lead_lost_reason: 'seats', lead_closed_id: '41' };
    expect(buildRequestView(charter, NOW).human).not.toMatch(/Причина: нет мест/);
    expect(shownAnswerRef(charter)).toBeNull();
    // Причины нет или она не из словаря — прежние общие слова, без выдумки.
    expect(buildRequestView({ ...LEAD, lead_lost_reason: null }, NOW).human).toBe(GENERIC);
    expect(buildRequestView({ ...LEAD, lead_lost_reason: 'просто так', lead_closed_id: '41' }, NOW).human).toBe(GENERIC);
    // Причина есть, а записи журнала нет — слова по причине, но ссылаться сообщению не на что.
    const noRow = { ...LEAD, lead_lost_reason: 'dates', lead_closed_id: null };
    expect(buildRequestView(noRow, NOW).human).toBe('Оператор отказал по заявке. Причина: даты не подходят.');
    expect(shownAnswerRef(noRow)).toBeNull();
  });

  it('закрытие с причиной главнее ответа кнопкой: причину стирает любая смена статуса, значит ответ старше', () => {
    const both = {
      ...LEAD, lead_answer: 'decline', lead_decline_reason: 'weather', lead_answer_id: '7',
      lead_lost_reason: 'dates', lead_closed_id: '44',
    };
    expect(buildRequestView(both, NOW).human).toBe('Оператор отказал по заявке. Причина: даты не подходят.');
    expect(shownAnswerRef(both)).toEqual({ source: 'closed', id: '44' });
    // Без причины в заявке говорит ответ кнопкой — как раньше.
    const pressed = { ...both, lead_lost_reason: null, lead_closed_id: null };
    expect(buildRequestView(pressed, NOW).human).toBe('Оператор отказал по заявке. Причина: погода, безопасность.');
    expect(shownAnswerRef(pressed)).toEqual({ source: 'tour', id: '7' });
  });
});

describe('поток двери: что на деле ушло человеку', () => {
  const scope = { kind: 'owner' as const, partnerId: 'P', claimUnowned: true };
  const actor = { kind: 'partner_user' as const, userId: 'u' };
  const ok = (closed?: { activityId: string; notice: { id: string; state: 'pending' | 'skipped'; skipped: string | null } | null }): LeadChangeResult => ({
    kind: 'ok', changed: true, prevStatus: 'new', lead: { id: 'L', status: 'lost', notes: null }, ...(closed ? { closed } : {}),
  });
  const run = (
    reason: Parameters<typeof closeLeadWithReason>[0]['reason'], result: LeadChangeResult, deliver = vi.fn(),
    ask: (leadId: string) => Promise<string | null> = vi.fn(async () => null),
  ) => {
    const change = vi.fn(async () => result);
    return closeLeadWithReason({ leadId: 'L', reason, notes: 'звонил', actor, scope, via: 'site' }, { change, deliver, ask })
      .then((r) => ({ r, change, deliver, ask }));
  };

  it('в запись уходит статус «lost», причина и карточка продавца; сообщение отправляет дверь и говорит исход', async () => {
    const deliver = vi.fn(async () => ({ state: 'delivered' as const, via: 'max' as const, dates: [] }));
    const { r, change } = await run('seats', ok({ activityId: '9', notice: { id: '77', state: 'pending', skipped: null } }), deliver);
    expect(change).toHaveBeenCalledWith({
      leadId: 'L', status: 'lost', notes: 'звонил', actor, scope, via: 'site', lost: { reason: 'seats', partnerId: 'P' },
    });
    expect(deliver).toHaveBeenCalledWith('77');
    expect(r.touristLine).toBe('Туристу ушло сообщение в MAX: ваш ответ.');
  });

  it('не дошло — продавцу так и сказано, с тем, кто теперь позвонит', async () => {
    const deliver = vi.fn(async () => ({
      state: 'undelivered' as const, manager: 'max' as const, why: { chat: 'none' as const, agent: 'none' as const, broken: false },
    }));
    const { r } = await run('weather', ok({ activityId: '9', notice: { id: '77', state: 'pending', skipped: null } }), deliver);
    expect(r.touristLine).toMatch(/^Туристу сообщить не удалось: чат с ним не подключён\./);
    expect(r.touristLine).toMatch(/менеджер Ведара — он позвонит/);
  });

  it('причина клиента, ничейная заявка, своя проба, заявка на машину — отправки нет, и сказано почему', async () => {
    const client = await run('no_contact', ok({ activityId: '9', notice: null }));
    expect(client.r.touristLine).toBe(CLIENT_REASON_LINE);
    expect(client.deliver).not.toHaveBeenCalled();

    const unowned = await run('seats', ok({ activityId: '9', notice: { id: '77', state: 'skipped', skipped: 'not_addressee' } }));
    expect(unowned.r.touristLine).toBe(NOT_ADDRESSED_LINE);
    expect(unowned.deliver).not.toHaveBeenCalled();

    const self = await run('seats', ok({ activityId: '9', notice: { id: '77', state: 'skipped', skipped: 'self' } }));
    expect(self.r.touristLine).toMatch(/тестовая заявка/);
    expect(self.deliver).not.toHaveBeenCalled();

    const vehicle = await run('seats', ok({ activityId: '9', notice: null }));
    expect(vehicle.r.touristLine).toBe(NO_NOTICE_KIND_LINE);
    expect(vehicle.deliver).not.toHaveBeenCalled();
  });

  it('после отказа продавца другим компаниям задан вопрос — продавцу сказано строкой; сбой вопросов отказ не роняет', async () => {
    const pending = ok({ activityId: '9', notice: { id: '77', state: 'pending', skipped: null } });
    const deliver = vi.fn(async () => ({ state: 'delivered' as const, via: 'max' as const, dates: [] }));
    const ASKED = 'Другим компаниям с турами к этому месту (2) задан вопрос, возьмут ли они туриста на эту дату, — без его имени и телефона.';
    const asked = await run('seats', pending, deliver, vi.fn(async () => ASKED));
    expect(asked.ask).toHaveBeenCalledWith('L');
    expect(asked.r.touristLine).toBe(`Туристу ушло сообщение в MAX: ваш ответ. ${ASKED}`);
    // Вопросов нет (погода, группа, некого спросить) — строка прежняя.
    const none = await run('seats', pending, deliver, vi.fn(async () => null));
    expect(none.r.touristLine).toBe('Туристу ушло сообщение в MAX: ваш ответ.');
    // Вопросы упали — заявка закрыта, человеку сообщено, о вопросах ни слова.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = await run('seats', pending, deliver, vi.fn(async () => { throw new Error('boom'); }));
    expect(broken.r.outcome.kind).toBe('ok');
    expect(broken.r.touristLine).toBe('Туристу ушло сообщение в MAX: ваш ответ.');
    error.mockRestore();
  });

  it('сообщение человеку не рождалось (причина клиента, ничейная, своя проба, машина) — и вопросов другим компаниям нет', async () => {
    const cases: Array<[Parameters<typeof closeLeadWithReason>[0]['reason'], LeadChangeResult]> = [
      ['no_contact', ok({ activityId: '9', notice: null })],
      ['seats', ok({ activityId: '9', notice: { id: '77', state: 'skipped', skipped: 'not_addressee' } })],
      ['seats', ok({ activityId: '9', notice: { id: '77', state: 'skipped', skipped: 'self' } })],
      ['seats', ok({ activityId: '9', notice: null })],
      ['seats', { kind: 'not_found' }],
    ];
    for (const [reason, result] of cases) {
      const { ask } = await run(reason, result);
      expect(ask, `${reason}/${JSON.stringify(result)}`).not.toHaveBeenCalled();
    }
  });

  it('отказ этим запросом не записан (не найдена, уже закрыта, отменена клиентом) — о туристе не говорится ничего', async () => {
    const missing = await run('seats', { kind: 'not_found' });
    expect(missing.r).toEqual({ outcome: { kind: 'not_found' }, touristLine: null });
    const already: LeadChangeResult = { kind: 'ok', changed: false, prevStatus: 'lost', lead: { id: 'L', status: 'lost', notes: null } };
    const again = await run('seats', already);
    expect(again.r.touristLine).toBeNull();
    expect(again.deliver).not.toHaveBeenCalled();
  });

  it('зависшая отправка не держит форму: после срока нажатия — «отправляется», а не «ушло»', async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi.fn(() => new Promise<never>(() => undefined));
      const pending = run('seats', ok({ activityId: '9', notice: { id: '77', state: 'pending', skipped: null } }), deliver);
      await vi.advanceTimersByTimeAsync(NOTICE_PRESS_BUDGET_MS + 10);
      const { r } = await pending;
      expect(r.touristLine).not.toMatch(/ушло сообщение/);
      expect(r.touristLine).toMatch(/отправля/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Экран оператора ──────────────────────────────────────────────────────────

const SOURCE = { source: 'mcp', entry: 'kuzmich-max', tool: 'create_booking_request' };
function lead(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'l-1', name: 'Тест', phone: '+70000000000', email: null, comment: null, route_id: null, route_title: null,
    status, notes: null, ai_score: null, ai_summary: null, group_size: null, budget_rub: null, desired_dates: null,
    proposal_id: null, created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z', has_recipient: true,
    source_url: 'mcp://vedar/booking', source_data: SOURCE,
    origin: leadOrigin({ source_url: 'mcp://vedar/booking', source_data: SOURCE, pd_consent_source: null }),
    ...extra,
  };
}

let patches: Array<Record<string, unknown>> = [];
function stubApi(
  row: ReturnType<typeof lead>,
  opts: { needsReason: boolean; patch?: Record<string, unknown>; afterPatch?: ReturnType<typeof lead> },
) {
  patches = [];
  let current = row;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (init?.method === 'PATCH') {
      patches.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      // Сервер записал отметку: следующее чтение заявки отдаёт её уже такой.
      if (opts.afterPatch) current = opts.afterPatch;
      return { ok: true, status: 200, json: async () => opts.patch ?? { success: true, changed: true } } as Response;
    }
    const body = u.endsWith('/proposal') ? { proposal: null } : { lead: current, bookings: [], lost_needs_reason: opts.needsReason };
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}
const renderCard = () => render(
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><LeadDetailClient leadId="l-1" /></SWRConfig>,
);

describe('экран оператора: «Потерян» — только с причиной', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('продавцу «Потерян» открывает выбор причины; запрос уходит с ней; что ушло туристу — остаётся на экране', async () => {
    const TOURIST = 'Туристу сообщить не удалось: чат с ним не подключён. Заявку с телефоном получил менеджер Ведара — он позвонит.';
    stubApi(lead('new'), {
      needsReason: true,
      patch: { success: true, changed: true, tourist: TOURIST },
      afterPatch: lead('lost', { lost_reason: 'dates' }),
    });
    renderCard();
    await screen.findByText('Статус и действия');
    fireEvent.click(screen.getByRole('button', { name: 'Потерян' }));
    // Нажатие статуса ничего не отправило: сначала причина.
    expect(patches).toEqual([]);
    const chooser = screen.getByTestId('lost-reason-chooser');
    expect(within(chooser).getByRole('group', { name: 'Отказываю я' }).textContent).toContain('Туристу уйдёт сообщение Ведара');
    expect(within(chooser).getByRole('group', { name: 'Причина на стороне клиента' }).textContent).toContain('Туристу ничего не уйдёт');
    expect(within(chooser).getAllByRole('button').map((b) => b.textContent))
      .toEqual([...LOST_REASONS.map((r) => LOST_REASON_LABEL[r]), 'Назад']);

    fireEvent.click(within(chooser).getByRole('button', { name: 'Даты не подходят' }));
    await waitFor(() => expect(patches).toEqual([{ status: 'lost', lostReason: 'dates' }]));
    await waitFor(() => expect(screen.queryByTestId('lost-reason-chooser')).toBeNull());
    // Исход для туриста — словами сервера и строкой на карточке, а не уведомлением на пять секунд.
    expect(await screen.findByText(TOURIST)).toBeTruthy();
    expect(screen.getByText('Причина отказа: даты не подходят.')).toBeTruthy();
  });

  it('«Назад» из выбора причины ничего не отправляет; остальные статусы уходят сразу, как раньше', async () => {
    stubApi(lead('new'), { needsReason: true });
    renderCard();
    await screen.findByText('Статус и действия');
    fireEvent.click(screen.getByRole('button', { name: 'Потерян' }));
    fireEvent.click(within(screen.getByTestId('lost-reason-chooser')).getByRole('button', { name: 'Назад' }));
    expect(screen.queryByTestId('lost-reason-chooser')).toBeNull();
    expect(patches).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Контакт установлен' }));
    await waitFor(() => expect(patches).toEqual([{ status: 'contacted' }]));
  });

  it('администратору (не продавец заявки) выбор не показывается: его «Потерян» туристу ничего не обещает', async () => {
    stubApi(lead('new'), { needsReason: false });
    renderCard();
    await screen.findByText('Статус и действия');
    fireEvent.click(screen.getByRole('button', { name: 'Потерян' }));
    expect(screen.queryByTestId('lost-reason-chooser')).toBeNull();
    await waitFor(() => expect(patches).toEqual([{ status: 'lost' }]));
  });

  it('у закрытой заявки причина названа словами; без причины строки нет', async () => {
    stubApi(lead('lost', { lost_reason: 'no_contact' }), { needsReason: true });
    renderCard();
    expect(await screen.findByText('Причина отказа: клиент не отвечает.')).toBeTruthy();
    cleanup();
    stubApi(lead('lost', { lost_reason: null }), { needsReason: true });
    renderCard();
    await screen.findByText('Статус и действия');
    expect(screen.queryByText(/Причина отказа:/)).toBeNull();
  });
});
