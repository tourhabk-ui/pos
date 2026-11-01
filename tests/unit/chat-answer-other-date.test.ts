import { describe, expect, it } from 'vitest';
import { chatAnswerButtons, chatAnswerMarksContacted, chatAnswerText, parseChatAnswer } from '@/lib/requests/chat-answer';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';

describe('operator Confirm / Other date buttons', () => {
  it('payloads fit the Telegram 64-byte callback limit and parse back', () => {
    for (const b of chatAnswerButtons(9, 'lead', ID)) {
      expect(Buffer.byteLength(b.payload)).toBeLessThanOrEqual(64);
      expect(parseChatAnswer(b.payload)?.subjectId).toBe(ID);
    }
    expect(parseChatAnswer(`ia:d:l:${ID}`)).toEqual({ answer: 'other_date', kind: 'lead', subjectId: ID });
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
      expect(t).toMatch(/не бронь|бронь не создана/);
      expect(t).not.toMatch(/мгновенн|временно недоступн/);
    }
  });
});
