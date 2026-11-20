import { describe, it, expect } from 'vitest';
import { stripBannedAdvice, BANNED_ADVICE_NOTE } from '@/lib/kuzmich/banned-advice';
import { guardSafetyClaims } from '@/lib/kuzmich/safety-claim-guard';

describe('stripBannedAdvice', () => {
  it('вырезает «притворись мёртвым» и ставит 112', () => {
    const r = stripBannedAdvice('Не беги. Если атакует — падай на живот и притворись мёртвым. Ходи группой.');
    expect(r.text).not.toMatch(/притвор/i);
    expect(r.text).toContain('Не беги.');
    expect(r.text).toContain('Ходи группой.');
    expect(r.text).toContain(BANNED_ADVICE_NOTE);
    expect(r.removed).toHaveLength(1);
  });
  it('отрицание не трогает', () => {
    const a = 'Не притворяйся мёртвым, медленно отходи.';
    expect(stripBannedAdvice(a).text).toBe(a);
  });
  it('сторож утверждений применяет запрет', () => {
    expect(guardSafetyClaims('Притворитесь мёртвыми.', null).text).not.toMatch(/притвор/i);
  });
});

describe('SMS на 112 — не совет, пока МЧС не подтвердило (#3179 п.4)', () => {
  it('«СМС на 112 доходит лучше звонка» вырезается, звонок 112 остаётся', () => {
    const r = stripBannedAdvice('Звони 112. СМС на 112 при слабом сигнале доходит лучше звонка. Оставайся на месте.');
    expect(r.sms112).toHaveLength(1);
    expect(r.text).toBe('Звони 112. Оставайся на месте.');
  });
  it('оговорка «не подтверждено» — не совет, остаётся', () => {
    const text = 'Работает ли SMS на 112 на Камчатке, не подтверждено — звони.';
    expect(stripBannedAdvice(text)).toMatchObject({ text, sms112: [] });
  });
  it('112 без SMS — не трогается', () => {
    const text = 'Звони 112: работает без баланса и SIM.';
    expect(stripBannedAdvice(text)).toMatchObject({ text, sms112: [] });
  });
});
