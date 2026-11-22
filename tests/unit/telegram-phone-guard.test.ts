/** Телефон туриста в Telegram не принимается (решение владельца 22.11, pd-guard). */
import { describe, it, expect } from 'vitest';
import { hasPhone, maskPhones, PHONE_MASK, TG_PHONE_REFUSAL_BUTTONS, TG_PHONE_REFUSAL_TEXT } from '@/lib/telegram/phone-guard';

describe('распознавание номера', () => {
  it.each([
    '+7 914 123-45-67', '89141234567', '8 (914) 123 45 67', '+7(914)1234567', 'мой номер 8-914-123-45-67 звоните',
    '+1 202 555 0143',
  ])('номер: %s', (t) => expect(hasPhone(t)).toBe(true));

  it.each([
    '2027-07-10', '10.07.2027', 'бюджет 150 000 ₽', '150000', 'ID70', 'нас 2 взрослых и 1 ребёнок', '12-17 лет', '',
    '10.07.2027-15.07.2027', 'бюджет 150 000 - 200 000 ₽', '53.0195 158.6503', '53.019500, 158.650300',
  ])('не номер: %s', (t) => expect(hasPhone(t)).toBe(false));

  it('координаты в сообщении о беде не маскируются', () => {
    expect(maskPhones('мы тут 53.019500, 158.650300 помогите')).toBe('мы тут 53.019500, 158.650300 помогите');
  });

  it('маска заменяет только номер', () => {
    expect(maskPhones('мы заблудились, номер +7 914 123-45-67, 10.07')).toBe(`мы заблудились, номер ${PHONE_MASK}, 10.07`);
  });
});

describe('ответ', () => {
  it('сайт и MAX, без обещаний брони и оплаты', () => {
    expect(TG_PHONE_REFUSAL_BUTTONS.flat().map((b) => b.url)).toEqual(['https://vedarai.ru/contact', 'https://max.ru/id4101147649_biz']);
    expect(TG_PHONE_REFUSAL_TEXT).toContain('не бронь');
    expect(TG_PHONE_REFUSAL_TEXT).toContain('не сохраняю');
  });
});
