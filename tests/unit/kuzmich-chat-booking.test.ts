import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChatBookingPrefill } from '@/lib/kuzmich/booking-prefill';
import { TOURIST_PROMPT } from '@/lib/ai/prompts';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
const TODAY = new Date('2026-11-01T00:00:00Z');

describe('Кузьмич оформляет заявку в чате (01.11)', () => {
  it('дата и люди из реплики', () => {
    expect(parseChatBookingPrefill('хочу на Курильское 2027-07-15, нас 3', TODAY)).toEqual({ date: '2027-07-15', guests: 3 });
    expect(parseChatBookingPrefill('оформи на 15 июля, 2 человека', TODAY)).toEqual({ date: '2027-07-15', guests: 2 });
    expect(parseChatBookingPrefill('запиши 20.08 на четверых', TODAY)).toEqual({ date: '2027-08-20' });
    expect(parseChatBookingPrefill('31.02 5 чел', TODAY)).toEqual({ guests: 5 });
  });
  it('промпт: оформляет сам, один вопрос, без «сам не могу»', () => {
    expect(TOURIST_PROMPT).toMatch(/ПРЯМО В ЧАТЕ/);
    expect(TOURIST_PROMPT).toMatch(/ОДИН короткий вопрос/);
    expect(TOURIST_PROMPT).toMatch(/Заявка создана\. Оператор свяжется/);
  });
  it('чат отдаёт карточку с предзаполнением; карточка шлёт согласие', () => {
    const route = read('app/api/ai/chat/route.ts');
    expect(route).toMatch(/parseChatBookingPrefill\(rawMessage\)/);
    expect(route).toMatch(/prefillDate: bookingPrefill\.date/);
    const card = read('app/kuzmich/_KuzmichClient.tsx');
    expect(card).toMatch(/pd_consent: pdConsent/);
    expect(card).toMatch(/disabled=\{submitting \|\| !pdConsent\}/);
    expect(card).toMatch(/useState\(data\.prefillDate/);
  });
  it('веб-строка про ПД не говорит «сам не отправляю»', () => {
    expect(read('lib/kuzmich/answer-quality.ts')).not.toMatch(/'Имя и телефон — в форме на сайте, с согласием\. Сам я заявку не отправляю\.'/);
  });
});
