import { describe, expect, it } from 'vitest';
import {
  declineButton, declineReasonButtons, parseChatAnswer, chatAnswerLeadStatus, chatAnswerButtons,
} from '@/lib/requests/chat-answer-buttons';
import { unwrapPress } from '@/lib/chat-cabinet/signed-payload';
import { parseCabinetPress, cabinetPayload } from '@/lib/chat-cabinet/payload';
import { todaySelect, todayScreen, liveSeatsLine } from '@/lib/chat-cabinet/screens';
import type { InboxItem } from '@/lib/crm/inbox';

const ID = '4132a418-d6ec-4ccc-b762-241005023cf8';
const strip = (p: string) => { const r = unwrapPress(p); if (!r.ok) throw new Error(r.reason); return r.payload; };

describe('Отказать с причиной (PR2)', () => {
  it('«Отказать» открывает выбор, ничего не записывая', () => {
    expect(parseChatAnswer(strip(declineButton('lead', ID).payload))).toEqual({ answer: 'decline_pick', kind: 'lead', subjectId: ID });
  });
  it('кнопки причин — пять, каждая разбирается в отказ с причиной, ≤64 байт', () => {
    const btns = declineReasonButtons('lead', ID).flat();
    expect(btns.map((b) => b.text)).toEqual(['Нет мест', 'Погода, безопасность', 'Даты не подходят', 'Не подходит группа', 'Другое']);
    const reasons = btns.map((b) => {
      expect(Buffer.byteLength(b.payload)).toBeLessThanOrEqual(64);
      const p = parseChatAnswer(strip(b.payload));
      return p && p.answer === 'decline' ? p.reason : null;
    });
    expect(reasons).toEqual(['seats', 'weather', 'dates', 'group', 'other']);
  });
  it('ia:m:… с кодом r напрямую не даёт отказ без причины', () => {
    expect(parseChatAnswer(`ia:r:l:${ID}`)).toBeNull();
    expect(parseChatAnswer(`ia:rz:l:${ID}`)).toBeNull();
  });
  it('отказ закрывает заявку статусом lost; прежние ответы — как были', () => {
    expect(chatAnswerLeadStatus('lead', 'decline')).toBe('lost');
    expect(chatAnswerLeadStatus('lead', 'accept')).toBe('contacted');
    expect(chatAnswerLeadStatus('lead', 'clarify')).toBeNull();
    expect(chatAnswerLeadStatus('booking', 'decline')).toBeNull();
    expect(chatAnswerButtons(null, 'lead', ID).map((b) => parseChatAnswer(strip(b.payload))?.answer))
      .toEqual(['accept', 'other_date', 'no_seats', 'clarify', 'self']);
  });
});

const item = (over: Partial<InboxItem>): InboxItem => ({
  kind: 'operator_booking', id: '1', created_at: '2026-10-01T00:00:00Z', title: 'Тур', date: null, people: 2,
  contact_id: null, contact_name: 'Иван Петров', waiting_minutes: 5, ...over,
});

describe('«Сегодня» (PR2)', () => {
  const now = Date.parse('2026-11-02T10:00:00Z');
  it('cb:td разбирается', () => {
    expect(parseCabinetPress(cabinetPayload.today())).toEqual({ kind: 'today' });
  });
  it('берёт новое за сутки и даты сегодня/завтра, сортирует по дате, не по ожиданию', () => {
    const items = [
      item({ id: 'a', date: '2026-11-03', waiting_minutes: 1 }),
      item({ id: 'b', created_at: '2026-11-02T08:00:00Z', date: null, waiting_minutes: 999 }),
      item({ id: 'c', date: '2026-11-02', waiting_minutes: 2 }),
      item({ id: 'd', date: '2026-11-20' }),
    ];
    expect(todaySelect(items, '2026-11-02', '2026-11-03', now).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
  it('экран без имён; отказ выездов назван честно', () => {
    const s = todayScreen({
      inbox: { category: 'operator', items: [item({ id: '7', date: '2026-11-02' })], failed: [], response: {} as never, chat: { state: 'none' }, not_here: [] },
      departures: 'failed', today: '2026-11-02', tomorrow: '2026-11-03', nowMs: now,
    });
    const text = JSON.stringify(s);
    expect(text).not.toContain('Иван');
    expect(text).toContain('Выезды не прочитались');
  });
  it('строка мест: число, нет даты, отказ чтения', () => {
    expect(liveSeatsLine({ date: '2026-11-05', free: 4 })).toMatch(/Свободно на .*: 4/);
    expect(liveSeatsLine({ date: '2026-11-05', free: null })).toMatch(/даты в календаре нет/);
    expect(liveSeatsLine('failed')).toMatch(/не прочитались/);
    expect(liveSeatsLine(null)).toBeNull();
  });
});
