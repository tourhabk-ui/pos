import { describe, it, expect } from 'vitest';
import { seasonLabel } from '@/lib/routes/season-label';

describe('сезон маршрута по-русски (02.11)', () => {
  it('коды переводятся', () => {
    // `all` импорт ставил по умолчанию — не факт, не показываем (#3568).
    expect(seasonLabel('all')).toBeNull();
    expect(seasonLabel('all-year')).toBeNull();
    expect(seasonLabel('summer')).toBe('Лето');
    expect(seasonLabel('winter')).toBe('Зима');
  });
  it('русский текст как есть, пустое и непонятный код — не показываем', () => {
    expect(seasonLabel('Летний сезон')).toBe('Летний сезон');
    expect(seasonLabel(null)).toBeNull();
    expect(seasonLabel('  ')).toBeNull();
    expect(seasonLabel('offseason')).toBeNull();
  });
});
