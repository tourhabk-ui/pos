/**
 * Telegram-паритет кабинета перевозчика (#2862 этап D) — рендером экранов и
 * разбором кнопок, не чтением исходника.
 *
 * Правило: всё, что перевозчик может нажать в MAX, он может нажать и в
 * Telegram; тексты Telegram без имени и телефона заказчика; где нужны имя и
 * телефон — сказано, что они в MAX или на сайте.
 *
 *  - карточка заявки на машину во «Входящих» (Telegram): «Беру» / «Не могу»
 *    есть, кнопки «Ответить клиенту» (ПД) нет, имени и телефона в тексте нет,
 *    и сказано, где они;
 *  - карточка «Поездка состоялась?» (Telegram): обе кнопки исхода есть;
 *  - «Ещё», «Машины и прайс», «Сводка» — одни и те же кнопки в обоих каналах,
 *    экраны без ПД (pd: false), в клавиатуру Telegram кнопки попадают;
 *  - каждая кнопка перевозчика разбирается своим разборщиком и влезает в
 *    64 байта callback_data;
 *  - уведомление о заявке в Telegram (заглушка) — без имени и телефона и
 *    называет, где ответить.
 */
import { describe, it, expect } from 'vitest';
import { fleetScreen, itemCardScreen, moreScreen, carrierSummaryScreen, type CabinetPartner } from '@/lib/chat-cabinet/screens';
import { telegramCabinetKeyboard } from '@/lib/chat-cabinet/render';
import { CABINET_PAYLOAD_MAX_BYTES, parseCabinetPress } from '@/lib/chat-cabinet/payload';
import { parseRequestAnswer } from '@/lib/rental/request-answer';
import { parseRideOutcomePress } from '@/lib/transfers/ride-outcome';
import { partnerRequestTexts } from '@/lib/notifications/partner-request-notify';
import type { InboxItem } from '@/lib/crm/inbox';

const BASE = 'https://vedarai.ru';
const LEAD = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const CONTACT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NAME = 'Анна Петрова';
const PHONE = '+79140001122';
const PD = [NAME, 'Петрова', PHONE, '79140001122'];

const carrier: CabinetPartner = {
  partnerId: '11111111-1111-4111-8111-111111111111', role: 'transfer', seat: 'owner',
  bookingActions: false, leadActions: false, operatorAnswers: false, sellsTours: false, summary: false,
};

function item(kind: InboxItem['kind']): InboxItem {
  return {
    kind, id: LEAD, created_at: '2026-10-29T00:00:00.000Z', title: 'Авачинский перевал', date: '2026-11-05', people: 6,
    contact_id: CONTACT, contact_name: NAME, waiting_minutes: 190,
  };
}

const payloads = (rows: Array<Array<Record<string, unknown>>>) => rows.flat().flatMap((b) => (typeof b.payload === 'string' ? [b.payload] : []));
const noPd = (where: string, v: unknown) => { const j = JSON.stringify(v); for (const p of PD) expect(j, `${where}: ${p}`).not.toContain(p); };

describe('карточки «Входящих» перевозчика в Telegram', () => {
  it('заявка на машину: «Беру» / «Не могу» есть, ПД нет, где контакты — сказано', () => {
    const tg = itemCardScreen({ item: item('charter_request'), partner: carrier, channel: 'telegram', base: BASE });
    const max = itemCardScreen({ item: item('charter_request'), partner: carrier, channel: 'max', base: BASE });
    const tgPayloads = payloads(tg.rows);
    const answer = tgPayloads.filter((p) => p.startsWith('rr:'));
    expect(answer).toHaveLength(2);
    for (const p of answer) expect(parseRequestAnswer(p)?.leadId).toBe(LEAD);
    // Те же кнопки ответа, что в MAX.
    expect(payloads(max.rows).filter((p) => p.startsWith('rr:'))).toEqual(answer);
    expect(tg.pd).toBe(false);
    noPd('карточка заявки telegram', tg);
    expect(tg.text).toMatch(/MAX|на сайте/);
    // Клавиатура Telegram несёт обе кнопки ответа.
    const kb = telegramCabinetKeyboard(tg.rows);
    const data = kb.inline_keyboard.flat().flatMap((b) => ('callback_data' in b ? [b.callback_data] : []));
    expect(data.filter((d) => d.startsWith('rr:'))).toEqual(answer);
  });

  it('«Поездка состоялась?»: обе кнопки исхода в Telegram, без ПД', () => {
    const tg = itemCardScreen({ item: item('charter_ride'), partner: carrier, channel: 'telegram', base: BASE });
    const ride = payloads(tg.rows).filter((p) => p.startsWith('rc:'));
    expect(ride.map((p) => parseRideOutcomePress(p)?.outcome).sort()).toEqual(['held', 'not_held']);
    expect(tg.pd).toBe(false);
    noPd('карточка поездки telegram', tg);
  });
});

describe('«Ещё», «Машины и прайс», «Сводка» — одинаковы в обоих каналах', () => {
  it('кнопки одни и те же, экраны без ПД, каждая кнопка разбирается и влезает в 64 байта', () => {
    const more = moreScreen(carrier, BASE);
    const morePayloads = payloads(more.rows);
    expect(morePayloads).toContain('cb:v');
    expect(morePayloads).toContain('cb:y');
    expect(more.pd).toBe(false);

    const vehicle = { id: CONTACT, kind: 'vahtovka' as const, title: 'КамАЗ', seats: 26, notes: null, is_active: true };
    const fleet = fleetScreen({ vehicles: [vehicle], prices: [], drafts: [], base: BASE });
    expect(fleet.pd).toBe(false);
    const summary = carrierSummaryScreen({ windowDays: 30, requests: null, rides: null, reviews: null }, BASE);
    expect(summary.pd).toBe(false);

    for (const p of [...morePayloads, ...payloads(fleet.rows), ...payloads(summary.rows)]) {
      expect(Buffer.byteLength(p), p).toBeLessThanOrEqual(CABINET_PAYLOAD_MAX_BYTES);
      const known = p.startsWith('cb:') ? parseCabinetPress(p) !== null : /^rm:tf:(hp|sm)$/.test(p);
      expect(known, p).toBe(true);
    }
    // Telegram получает те же кнопки: ни одна не выпадает из клавиатуры.
    const kb = telegramCabinetKeyboard(fleet.rows);
    expect(kb.inline_keyboard.flat().some((b) => 'callback_data' in b && b.callback_data === `cb:v:z:${CONTACT}`)).toBe(true);
  });
});

describe('уведомление о заявке в Telegram', () => {
  it('заглушка без имени и телефона, называет, где ответить; текст MAX — с ними', () => {
    const notice = {
      partnerId: carrier.partnerId, leadId: LEAD, kind: 'charter' as const,
      lines: ['Направление: Петропавловск — Авачинский перевал', 'Дата: 05.11.2026', 'Пассажиров: 6'],
      name: NAME, phone: PHONE, comment: 'заберите у гостиницы',
    };
    const { text, stub } = partnerRequestTexts(notice);
    noPd('заглушка telegram', stub);
    expect(stub).toContain('Контакты заказчика — у менеджера Ведара');
    expect(stub).toMatch(/«Входящих»/);
    expect(text).toContain(NAME);
    expect(text).toContain(PHONE);
  });
});
