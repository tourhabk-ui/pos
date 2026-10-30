// @vitest-environment node
/**
 * «Поездка состоялась» / «Не состоялась» от перевозчика (#2862 этап B,
 * 30.10). До этого дня подтвердить поездку по заявке на машину мог только
 * менеджер Ведара, и отзыв без него был невозможен; §14 называл: кнопка у
 * перевозчика появится вместе с доказательством НОВОГО рода.
 *
 * Сторож держит вызовом:
 *   · исход пишется один раз (ride_outcome, индекс 1353), только по заявке
 *     с ответом «Беру» и только когда поездка закончилась по Камчатке;
 *   · «состоялась» — ссылка на отзыв выдаётся как перевозчиком
 *     (confirmedByKind carrier), уходит заказчику в переписку, лид →
 *     converted; не дошла — её передаёт менеджер, и это сказано;
 *   · «не состоялась» — лид → lost, ссылки нет;
 *   · род доказательства отзыва — по тому, кто подтвердил: строка под
 *     отзывом говорит «перевозчик», запись в carrier_reviews — charter_carrier;
 *   · карточка кабинета в чате даёт кнопки в обоих каналах; Telegram-нажатие
 *     не из пилота идёт без строки проката; дверь сайта — перевозчику;
 *   · вид charter_ride во «Входящих» и напоминаниях, в медиану не идёт,
 *     CHECK напоминаний его знает (1353).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { pool, statusMock, postMock, tgMock, lookupMock, requirePartnerMock, issueMock, dbQuery, txClient } = vi.hoisted(() => ({
  pool: vi.fn(), statusMock: vi.fn(), postMock: vi.fn(), tgMock: vi.fn(), lookupMock: vi.fn(), requirePartnerMock: vi.fn(),
  issueMock: vi.fn(), dbQuery: vi.fn(), txClient: { query: vi.fn() },
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => pool(...a),
    connect: async () => ({ query: (...a: unknown[]) => pool(...a), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({
  query: (...a: unknown[]) => dbQuery(...a),
  transaction: async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient),
}));
vi.mock('@/lib/leads/owner-lead-status', () => ({ changeLeadStatus: (...a: unknown[]) => statusMock(...a) }));
vi.mock('@/lib/requests/request-chat-service', () => ({ postOwnerMessage: (...a: unknown[]) => postMock(...a) }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgMock(...a) }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat: (...a: unknown[]) => lookupMock(...a) }));
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartnerMock(...a) }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));
vi.mock('@/lib/transfers/carrier-reviews', async (orig) => ({
  ...(await orig<typeof import('@/lib/transfers/carrier-reviews')>()),
  issueCharterInvite: (...a: unknown[]) => issueMock(...a),
}));

import { recordRideOutcome, handleRideOutcomePress } from '@/lib/transfers/ride-outcome-flow';
import { clientRideHeldText, parseRideOutcomePress, rideEnded, rideOutcomeButtons, rideTellStatus, rideTellText } from '@/lib/transfers/ride-outcome';
import { proofOfConfirmation, reviewProofLine } from '@/lib/transfers/carrier-review-rules';
import { writeInviteReview } from '@/lib/transfers/carrier-reviews';
import { itemCardScreen, type CabinetPartner } from '@/lib/chat-cabinet/screens';
import { tryRentalCabinetTelegramPress } from '@/lib/rental/cabinet-telegram';
import { INBOX_BY_CATEGORY, INBOX_KINDS, RESPONSE_METRIC_KINDS, inboxActionFor } from '@/lib/crm/inbox-kinds';
import { INBOX_REMIND_KINDS, INBOX_REMIND_SQL } from '@/lib/crm/inbox-reminders';
import { INBOX_SQL } from '@/lib/crm/inbox-sql';
import { pressActionOf } from '@/lib/max/verified-press';
import type { InboxItem } from '@/lib/crm/inbox';

const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const LEAD = '33333333-3333-4333-8333-333333333333';
const KEY = 'k'.repeat(32);
const PHONE = '+79001234567';
const SHATUN = { partnerId: PARTNER, partnerName: 'Шатун', slug: 'shatun', userId: 'u-shatun' };
/** 30.10.2026 10:00 по Камчатке. */
const NOW = new Date('2026-10-29T22:00:00Z');

function charterLead(over: Record<string, unknown> = {}) {
  return {
    id: LEAD, operator_id: PARTNER,
    source_data: { kind: 'charter', carrier_id: PARTNER, destination: 'Вулкан Горелый', date_from: '2026-10-28', date_to: '2026-10-29', passengers: 10, ...over },
  };
}

let journal: Array<Record<string, unknown>> = [];
let answer: 'take' | 'decline' | null = 'take';

function arm(opts: { lead?: Record<string, unknown> | null; priorOutcome?: 'held' | 'not_held' } = {}) {
  journal = [];
  pool.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const s = String(sql);
    if (/FROM leads/.test(s)) return { rows: opts.lead === null ? [] : [opts.lead ?? charterLead()] };
    if (/action = 'partner_answered'/.test(s) && /SELECT/.test(s)) return { rows: answer ? [{ answer }] : [] };
    if (/action = 'ride_outcome'/.test(s) && /SELECT/.test(s)) {
      const last = journal.at(-1);
      return { rows: opts.priorOutcome ? [{ outcome: opts.priorOutcome }] : last ? [{ outcome: last.outcome }] : [] };
    }
    if (/INSERT INTO lead_activity_log/.test(s)) {
      if (opts.priorOutcome || journal.length) throw Object.assign(new Error('dup'), { code: '23505' });
      journal.push(JSON.parse(String(params?.[1])) as Record<string, unknown>);
      return { rows: [] };
    }
    if (/FROM partners/.test(s)) return { rows: [{ name: 'Шатун', slug: 'shatun' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  pool.mockReset();
  answer = 'take';
  statusMock.mockReset().mockResolvedValue({ kind: 'ok', changed: true, prevStatus: 'contacted', lead: { id: LEAD, status: 'converted', notes: null } });
  postMock.mockReset().mockResolvedValue({ outcome: 'sent', delivery: 'max' });
  tgMock.mockReset().mockResolvedValue({ ok: true });
  issueMock.mockReset().mockResolvedValue({ ok: true, key: KEY, slug: 'shatun', expiresAt: '2026-11-29T00:00:00.000Z' });
  lookupMock.mockReset();
  requirePartnerMock.mockReset();
  dbQuery.mockReset();
  txClient.query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', '');
});

describe('чистые правила', () => {
  it('кнопки только на uuid; разбор; поездка закончилась — со следующего дня после последнего дня', () => {
    expect(rideOutcomeButtons('lead-7')).toBeUndefined();
    expect(rideOutcomeButtons(LEAD)?.map((b) => b.payload)).toEqual([`rc:y:${LEAD}`, `rc:n:${LEAD}`]);
    expect(parseRideOutcomePress(`rc:y:${LEAD}`)).toEqual({ outcome: 'held', leadId: LEAD });
    expect(parseRideOutcomePress(`rc:n:${LEAD.toUpperCase()}`)).toEqual({ outcome: 'not_held', leadId: LEAD });
    expect(parseRideOutcomePress(`rr:y:${LEAD}`)).toBeNull();
    expect(pressActionOf(`rc:y:${LEAD}`)).toBe('rental');
    expect(rideEnded('2026-10-28', '2026-10-29', '2026-10-30')).toBe(true);
    expect(rideEnded('2026-10-28', '2026-10-30', '2026-10-30')).toBe(false);
    expect(rideEnded('2026-10-30', null, '2026-10-30')).toBe(false);
    expect(rideEnded('2026-10-29', null, '2026-10-30')).toBe(true);
    expect(rideEnded('когда-нибудь', null, '2026-10-30')).toBeNull();
  });

  it('род доказательства — по тому, кто подтвердил; под отзывом это названо', () => {
    expect(proofOfConfirmation('manager')).toBe('charter');
    expect(proofOfConfirmation('carrier')).toBe('charter_carrier');
    expect(reviewProofLine({ proof: 'charter_carrier', rideDate: '2026-10-29', rideFrom: null, rideTo: 'Вулкан Горелый' }))
      .toBe('Машина под заказ: Вулкан Горелый, 29 октября: поездку подтвердил перевозчик');
    expect(reviewProofLine({ proof: 'charter', rideDate: '2026-10-29', rideFrom: null, rideTo: 'Вулкан Горелый' })).toContain('менеджер Ведара');
  });

  it('отзыв по ссылке перевозчика пишется родом charter_carrier; по ссылке менеджера — charter', async () => {
    const inviteRow = (kind: string | null) => ({
      lead_id: LEAD, expires_at: '2099-01-01T00:00:00Z', used_at: null, confirmed_by_kind: kind,
      destination: 'Вулкан Горелый', date_from: '2026-10-29', date_to: null,
    });
    for (const [kind, proof] of [['carrier', 'charter_carrier'], ['manager', 'charter'], [null, 'charter']] as const) {
      txClient.query.mockReset();
      txClient.query
        .mockResolvedValueOnce({ rows: [inviteRow(kind)] })
        .mockResolvedValueOnce({ rows: [{ id: '7' }] })
        .mockResolvedValueOnce({ rows: [] });
      const r = await writeInviteReview({ partnerId: PARTNER, key: KEY, authorName: 'Анна', rating: 5, comment: 'Ок' });
      expect(r).toEqual({ ok: true, id: '7' });
      const ins = txClient.query.mock.calls.find((c) => /INSERT INTO carrier_reviews/.test(String(c[0])))!;
      expect(ins[1]).toContain(proof);
      expect(String(ins[0])).not.toContain("'charter'");
    }
  });

  it('текст заказчику — ссылка, срок и «один отзыв», без суммы', () => {
    const t = clientRideHeldText('Шатун', 'https://vedarai.ru/transfers/shatun/review#k');
    expect(t).toContain('«Шатун» подтвердил, что поездка состоялась');
    expect(t).toContain('30 дней');
    expect(t).toContain('https://vedarai.ru/transfers/shatun/review#k');
    expect(t).not.toMatch(/₽|руб/);
  });
});

describe('исход поездки — запись и следствия', () => {
  it('«состоялась»: исход один, ссылка выдана как перевозчиком, заказчику в переписку, лид → converted, менеджеру без ПД и без ссылки', async () => {
    arm();
    const managers: string[] = [];
    const r = await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: async (t) => { managers.push(t); } });
    expect(r.tell).toEqual({ kind: 'held', clientTold: true, linkIssued: true, linkProblem: null });
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ outcome: 'held', kind: 'charter', destination: 'Вулкан Горелый', date_from: '2026-10-28', date_to: '2026-10-29' });
    expect(String(journal[0].at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(issueMock).toHaveBeenCalledTimes(1);
    expect(issueMock.mock.calls[0][0]).toMatchObject({ leadId: LEAD, confirmedBy: null, today: '2026-10-30', confirmedByKind: 'carrier', confirmedPartnerId: PARTNER });
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock.mock.calls[0][0]).toEqual({ kind: 'lead', id: LEAD });
    expect(String(postMock.mock.calls[0][1])).toContain(`/transfers/shatun/review#${KEY}`);
    expect(statusMock.mock.calls[0][0]).toMatchObject({ leadId: LEAD, status: 'converted', via: 'max', scope: { kind: 'owner', partnerId: PARTNER, claimUnowned: false } });
    expect(managers).toHaveLength(1);
    expect(managers[0]).toContain('подтвердил: поездка по заявке на машину');
    expect(managers[0]).not.toContain(PHONE);
    expect(managers[0]).not.toContain(KEY);
    expect(rideTellText(r.tell)).toContain('Заказчику отправлена ссылка');
    expect(rideTellStatus(r.tell)).toBe(200);
  });

  it('заказчику ссылка не ушла — перевозчику сказано, менеджеру передана ссылка; отзыв уже есть — ссылки нет, причина названа', async () => {
    arm();
    postMock.mockResolvedValue({ outcome: 'sent', delivery: 'no_address', pageVisible: false });
    const managers: string[] = [];
    const r = await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'site', now: NOW, notifyManager: async (t) => { managers.push(t); } });
    expect(r.tell).toEqual({ kind: 'held', clientTold: false, linkIssued: true, linkProblem: null });
    expect(rideTellText(r.tell)).toContain('передаст менеджер Ведара');
    expect(managers[0]).toContain(`/transfers/shatun/review#${KEY}`);

    arm();
    issueMock.mockResolvedValue({ ok: false, reason: 'already_reviewed' });
    const r2 = await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'site', now: NOW, notifyManager: async () => undefined });
    expect(r2.tell).toEqual({ kind: 'held', clientTold: null, linkIssued: false, linkProblem: 'отзыв по этой поездке уже оставлен' });
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(rideTellText(r2.tell)).toContain('Ссылка на отзыв не выдана: отзыв по этой поездке уже оставлен');
  });

  it('«не состоялась»: лид → lost, ссылки и сообщения заказчику нет, менеджеру — «заявка закрыта»', async () => {
    arm();
    const managers: string[] = [];
    const r = await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'not_held', via: 'telegram', now: NOW, notifyManager: async (t) => { managers.push(t); } });
    expect(r.tell).toEqual({ kind: 'not_held' });
    expect(journal[0]).toMatchObject({ outcome: 'not_held' });
    expect(issueMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    expect(statusMock.mock.calls[0][0]).toMatchObject({ status: 'lost', via: 'telegram' });
    expect(managers[0]).toContain('не состоялась. Заявка закрыта');
  });

  it('повтор — «уже записан»: без второй ссылки, статуса и менеджера; гонка двух нажатий решается индексом', async () => {
    arm();
    const quiet = async () => undefined;
    await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: quiet });
    const again = await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'not_held', via: 'max', now: NOW, notifyManager: quiet });
    expect(again.tell).toEqual({ kind: 'already', outcome: 'held' });
    expect(journal).toHaveLength(1);
    expect(issueMock).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(rideTellStatus(again.tell)).toBe(409);
  });

  it('без «Беру», до конца поездки, чужая и не-машина — ничего не записано', async () => {
    const quiet = async () => undefined;
    arm();
    answer = 'decline';
    expect((await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: quiet })).tell).toEqual({ kind: 'not_taken' });
    answer = null;
    expect((await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: quiet })).tell).toEqual({ kind: 'not_taken' });
    answer = 'take';
    arm({ lead: charterLead({ date_from: '2026-10-30', date_to: '2026-10-31' }) });
    expect((await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: quiet })).tell).toEqual({ kind: 'not_yet', lastDay: '2026-10-31' });
    arm({ lead: charterLead({ date_from: 'скоро', date_to: null }) });
    expect((await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: quiet })).tell).toEqual({ kind: 'not_yet', lastDay: null });
    arm({ lead: { ...charterLead(), operator_id: OTHER } });
    expect((await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: quiet })).tell).toEqual({ kind: 'not_yours' });
    arm({ lead: { id: LEAD, operator_id: PARTNER, source_data: { kind: 'car_rental', company_id: PARTNER } } });
    expect((await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: quiet })).tell).toEqual({ kind: 'not_yours' });
    arm({ lead: null });
    expect((await recordRideOutcome({ partner: SHATUN, leadId: LEAD, outcome: 'held', via: 'max', now: NOW, notifyManager: quiet })).tell).toEqual({ kind: 'missing' });
    expect(journal).toHaveLength(0);
    expect(issueMock).not.toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });
});

describe('поверхности', () => {
  it('MAX: сообщение с кнопками правится ответом; Telegram не из пилота — без строки проката', async () => {
    arm();
    const sent: Array<{ text: string; edit: string | null }> = [];
    await handleRideOutcomePress({
      lookup: { outcome: 'found', partner: SHATUN }, payload: `rc:y:${LEAD}`, editMid: 'mid-1', originalText: `Поездка состоялась?\nТелефон: ${PHONE}`,
      via: 'max', now: NOW, send: async (text, edit) => { sent.push({ text, edit }); }, notifyManager: async () => undefined,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].edit).toBe('mid-1');
    expect(sent[0].text).toContain('<b>Записано:</b> поездка состоялась');

    arm();
    lookupMock.mockResolvedValue({ outcome: 'found', partner: { ...SHATUN, category: 'transfer', crmCategory: 'transfer' } });
    const bare: string[] = [];
    const withBar: string[] = [];
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      expect(await tryRentalCabinetTelegramPress({ chatId: 777, payload: `rc:n:${LEAD}`, send: async (t) => { withBar.push(t); }, sendBare: async (t) => { bare.push(t); } })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(journal[0]).toMatchObject({ outcome: 'not_held' });
    expect(bare[0]).toContain('не состоялась');
    expect(withBar).toEqual([]);
  });

  it('карточка «Поездка состоялась?» в кабинете чата: кнопки в обоих каналах, переписка — в MAX; у оператора кнопок нет', () => {
    const partner: CabinetPartner = { partnerId: PARTNER, role: 'transfer', bookingActions: false, leadActions: false, operatorAnswers: false, sellsTours: false, summary: false, seat: 'owner' };
    const item: InboxItem = {
      kind: 'charter_ride', id: LEAD, created_at: '2026-10-29T12:00:00Z', title: 'Вулкан Горелый', date: '2026-10-28',
      people: 10, contact_id: null, contact_name: null, waiting_minutes: 600,
    };
    for (const channel of ['max', 'telegram'] as const) {
      const screen = itemCardScreen({ item, partner, channel, base: 'https://vedarai.ru' });
      const payloads = screen.rows.flat().map((b) => ('payload' in b ? b.payload : ''));
      expect(payloads, channel).toContain(`rc:y:${LEAD}`);
      expect(payloads, channel).toContain(`rc:n:${LEAD}`);
      expect(payloads.includes(`lq:o:${LEAD}`), channel).toBe(channel === 'max');
      expect(screen.text, channel).toContain('Поездка состоялась?');
      expect(screen.text, channel).toContain('подтвердили вы');
      expect(screen.pd, channel).toBe(false);
    }
    const op = itemCardScreen({ item, partner: { ...partner, role: 'operator' }, channel: 'max', base: 'https://vedarai.ru' });
    expect(op.rows.flat().map((b) => ('payload' in b ? b.payload : ''))).not.toContain(`rc:y:${LEAD}`);
    // Менеджер команды исход поездки не отмечает и переписку не ведёт: это слово владельца карточки.
    const member = itemCardScreen({ item, partner: { ...partner, seat: 'member' }, channel: 'max', base: 'https://vedarai.ru' });
    const memberPayloads = member.rows.flat().map((b) => ('payload' in b ? b.payload : ''));
    expect(memberPayloads).not.toContain(`rc:y:${LEAD}`);
    expect(memberPayloads).not.toContain(`lq:o:${LEAD}`);
  });

  it('дверь сайта: перевозчик — 200 и текст без разметки; не перевозчик — 403 без чтения; кривое тело — 400', async () => {
    const { POST } = await import('@/app/api/hub/crm/charter-rides/[id]/outcome/route');
    const req = (body: unknown) => new NextRequest(`http://localhost/api/hub/crm/charter-rides/${LEAD}/outcome`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    });
    const params = Promise.resolve({ id: LEAD });
    arm();
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      requirePartnerMock.mockResolvedValue({ outcome: 'ok', partnerId: PARTNER, category: 'transfer', userId: 'u-shatun', seat: 'owner' });
      const res = await POST(req({ outcome: 'held' }), { params });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ success: true, outcome: 'held' });
      expect(json.message).not.toMatch(/<b>/);
      expect(statusMock.mock.calls[0][0]).toMatchObject({ via: 'site', status: 'converted' });
      expect(tgMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    pool.mockClear();
    requirePartnerMock.mockResolvedValue({ outcome: 'ok', partnerId: PARTNER, category: 'operator', userId: 'u', seat: 'owner' });
    expect((await POST(req({ outcome: 'held' }), { params })).status).toBe(403);
    requirePartnerMock.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));
    expect((await POST(req({ outcome: 'held' }), { params })).status).toBe(401);
    requirePartnerMock.mockResolvedValue({ outcome: 'ok', partnerId: PARTNER, category: 'transfer', userId: 'u', seat: 'owner' });
    expect((await POST(req({ outcome: 'maybe' }), { params })).status).toBe(400);
    expect(pool).not.toHaveBeenCalled();
  });
});

describe('словарь «Входящих», напоминания, миграция', () => {
  it('вид charter_ride у перевозчика; в медиану не идёт; ждёт только после «Беру» и после конца поездки; напоминание наше', () => {
    expect(INBOX_BY_CATEGORY.transfer).toEqual(['charter_request', 'charter_ride']);
    expect([...INBOX_KINDS]).toContain('charter_ride');
    expect(RESPONSE_METRIC_KINDS.has('charter_ride')).toBe(false);
    expect(inboxActionFor('transfer', 'charter_ride').href).toBeNull();
    expect(inboxActionFor('transfer', 'charter_ride').hint).toMatch(/ссылку на отзыв/);
    for (const sql of [INBOX_SQL.charter_ride, INBOX_REMIND_SQL.charter_ride]) {
      expect(sql).toMatch(/details->>'answer' = 'take'/);
      expect(sql).toMatch(/action = 'ride_outcome'/);
      expect(sql).toMatch(/AT TIME ZONE 'Asia\/Kamchatka'/);
    }
    expect([...INBOX_REMIND_KINDS]).toContain('charter_ride');
  });

  it('миграция 1353: род charter_carrier, кто подтвердил, один исход на заявку, CHECK напоминаний', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/1353_charter_ride_outcome.sql'), 'utf8');
    // 1235 дала proof десять знаков — 'charter_carrier' длиннее: тип расширен до CHECK, иначе 22001 при зелёном CHECK.
    expect(sql).toMatch(/ALTER COLUMN proof TYPE VARCHAR\((\d+)\)/);
    expect(Number(/ALTER COLUMN proof TYPE VARCHAR\((\d+)\)/.exec(sql)![1])).toBeGreaterThanOrEqual('charter_carrier'.length);
    expect(sql.indexOf('ALTER COLUMN proof TYPE')).toBeLessThan(sql.indexOf("CHECK (proof IN ('seat', 'charter', 'charter_carrier'))"));
    expect(sql).toMatch(/carrier_reviews_proof_check[\s\S]*CHECK \(proof IN \('seat', 'charter', 'charter_carrier'\)\)/);
    expect(sql).toMatch(/confirmed_by_kind TEXT NOT NULL DEFAULT 'manager'/);
    expect(sql).toMatch(/CHECK \(confirmed_by_kind IN \('manager', 'carrier'\)\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS lead_activity_log_ride_outcome_uidx[\s\S]*WHERE action = 'ride_outcome'/);
    const check = /ADD CONSTRAINT crm_inbox_reminders_kind_check CHECK \(item_kind IN \(([\s\S]*?)\)\)/.exec(sql);
    for (const kind of INBOX_REMIND_KINDS) expect(check![1], kind).toContain(`'${kind}'`);
  });
});
