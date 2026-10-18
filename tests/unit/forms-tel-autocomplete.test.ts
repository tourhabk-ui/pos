/**
 * Формы варианта А (дизайн-аудит 18.10, PR 19.10): телефон — с цифровой
 * клавиатурой и автоподстановкой, имя — с autocomplete, подписи видимые.
 * Логику отправки, поля и валидацию этот PR не трогает — только атрибуты
 * и label, поэтому сторож читает разметку форм как контракт браузера.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const HOME = read('app/_home/_HomeV8Client.tsx');
const BOOKING = read('components/marketplace/BookingFormClient.tsx');
const SEAT = read('components/planner/SeatRequestForm.tsx');
const STICKY = read('components/shared/StickyLeadButton.tsx');

describe('лид-форма главной', () => {
  it('телефон: type tel + inputMode tel + autoComplete tel; имя: autoComplete name', () => {
    expect(HOME).toMatch(/id="lead-phone" type="tel" inputMode="tel" autoComplete="tel"/);
    expect(HOME).toMatch(/id="lead-name" type="text" autoComplete="name"/);
  });

  it('подписи видимые и связаны с полями, а не только placeholder/aria-label', () => {
    expect(HOME).toContain('<label htmlFor="lead-name">Имя</label>');
    expect(HOME).toContain('<label htmlFor="lead-phone">Телефон или Telegram</label>');
  });
});

describe('заявка на карточке тура', () => {
  it('основная форма уже была корректна — контракт не ослаблен', () => {
    expect(BOOKING).toMatch(/id="booking-phone"[\s\S]{0,120}type="tel"/);
    expect(BOOKING).toContain('inputMode="tel"');
    expect(BOOKING).toContain('autoComplete="tel"');
    expect(BOOKING).toContain('autoComplete="name"');
    expect(BOOKING).toContain('<label htmlFor="booking-phone"');
  });

  it('запрос мест оператору: телефону добавлен inputMode tel', () => {
    expect(SEAT).toMatch(/type="tel" inputMode="tel"/);
    expect(SEAT).toContain('autoComplete="tel"');
    expect(SEAT).toContain('<span className="ds-label">Телефон</span>');
  });
});

describe('попап плавающей кнопки (где она осталась)', () => {
  it('телефон и имя — с клавиатурой и автоподстановкой', () => {
    expect(STICKY).toMatch(/type="tel" inputMode="tel" autoComplete="tel"/);
    expect(STICKY).toContain('autoComplete="name"');
  });
});
