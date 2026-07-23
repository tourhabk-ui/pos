import { describe, it, expect } from 'vitest';
import { redactPII, hasPII } from '@/lib/security/pii-redact';

describe('redactPII — режет телефоны и email перед зарубежным LLM', () => {
  it('российский телефон в разных форматах → [телефон]', () => {
    expect(redactPII('звоните +7 999 123-45-67')).toBe('звоните [телефон]');
    expect(redactPII('89991234567 мой номер')).toBe('[телефон] мой номер');
    expect(redactPII('тел 8 (999) 123 45 67')).toContain('[телефон]');
  });

  it('email → [email]', () => {
    expect(redactPII('пишите ivan.petrov@mail.ru пожалуйста')).toBe('пишите [email] пожалуйста');
  });

  it('телефон + email вместе', () => {
    const out = redactPII('Иван, +79991234567, ivan@gmail.com');
    expect(out).toContain('[телефон]');
    expect(out).toContain('[email]');
    expect(out).not.toMatch(/79991234567|ivan@gmail/);
  });

  it('НЕ трогает короткие числа: цены, даты, группу', () => {
    expect(redactPII('бюджет 100000 рублей на 5 человек, даты 2026-07-15')).toBe(
      'бюджет 100000 рублей на 5 человек, даты 2026-07-15',
    );
  });

  it('чистый текст без ПД не меняется', () => {
    const clean = 'Хочу на вулкан Авачинский в июле, группа 3 человека';
    expect(redactPII(clean)).toBe(clean);
    expect(hasPII(clean)).toBe(false);
  });

  it('hasPII детектит наличие ПД', () => {
    expect(hasPII('мой +7 999 123 45 67')).toBe(true);
    expect(hasPII('a@b.ru')).toBe(true);
    expect(hasPII(null)).toBe(false);
  });

  it('пустой/nullable → пустая строка', () => {
    expect(redactPII(null)).toBe('');
    expect(redactPII(undefined)).toBe('');
    expect(redactPII('')).toBe('');
  });
});
