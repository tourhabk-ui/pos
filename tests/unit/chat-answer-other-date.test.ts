import { describe, expect, it } from 'vitest';
import { chatAnswerAsk, chatAnswerButtons, chatAnswerMarksContacted, chatAnswerText, parseChatAnswer } from '@/lib/requests/chat-answer';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';

describe('operator Confirm / Other date buttons', () => {
  it('payloads fit the Telegram 64-byte callback limit and parse back', () => {
    for (const b of chatAnswerButtons(9, 'lead', ID)) {
      expect(Buffer.byteLength(b.payload)).toBeLessThanOrEqual(64);
      expect(parseChatAnswer(b.payload)?.subjectId).toBe(ID);
    }
    expect(parseChatAnswer(`ia:d:l:${ID}`)).toEqual({ answer: 'other_date', kind: 'lead', subjectId: ID, confirmed: false });
    expect(parseChatAnswer(`ia:yd:l:${ID}`)).toEqual({ answer: 'other_date', kind: 'lead', subjectId: ID, confirmed: true });
  });
  it('only confirm / other date on a lead move status', () => {
    expect(chatAnswerMarksContacted('lead', 'accept')).toBe(true);
    expect(chatAnswerMarksContacted('lead', 'other_date')).toBe(true);
    expect(chatAnswerMarksContacted('lead', 'no_seats')).toBe(false);
    expect(chatAnswerMarksContacted('booking', 'accept')).toBe(false);
  });
  it('copy never promises a booking or payment', () => {
    for (const a of ['accept', 'other_date'] as const) {
      const t = chatAnswerText(a, false);
      expect(t).toMatch(/не подтверждена|бронь не создана/);
      expect(t).not.toMatch(/мгновенн|временно недоступн/);
    }
  });
});

describe('second «Да» on the five answer buttons (owner 02.11)', () => {
  it('first press only asks; «Да» carries the confirmed payload within 64 bytes', () => {
    for (const a of ['accept', 'other_date', 'no_seats', 'clarify', 'self'] as const) {
      const ask = chatAnswerAsk(a, 'lead', ID);
      expect(ask.text).toMatch(/\?/);
      const yes = ask.rows[0]![0]!.payload;
      expect(Buffer.byteLength(yes)).toBeLessThanOrEqual(64);
      expect(parseChatAnswer(yes)).toMatchObject({ answer: a, confirmed: true, subjectId: ID });
      expect(ask.rows[0]![1]!.payload.split('~')[0]).toBe('ia:no');
    }
  });
});
