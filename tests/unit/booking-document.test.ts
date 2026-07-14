/**
 * Лист безопасности в ваучере: опасности/снаряжение/МЧС/регистрация.
 * Дефолт МЧС Камчатки и 112 — всегда, даже если у маршрута нет данных.
 */
import { describe, it, expect } from 'vitest';
// Байтовую генерацию PDF не тестируем: bundled pdfkit не грузит шрифты в vitest-
// окружении (та же причина, по которой не покрыт proposal-generator). Генератор
// повторяет проверенный в проде паттерн; здесь тестируем чистую логику листа.
import { buildSafetyBlock, type BookingDocData } from '@/lib/pdf/booking-document';

const base: BookingDocData = {
  bookingId: '1001',
  operatorName: 'Kamland',
  tourTitle: 'Восхождение на Авачинский',
  bookingDate: '2026-08-01',
  participants: 3,
  totalPrice: 45000,
  touristName: 'Иван Петров',
};

describe('buildSafetyBlock', () => {
  it('прокидывает опасности и снаряжение маршрута', () => {
    const s = buildSafetyBlock({ ...base, hazards: ['камнепад', 'высота'], equipment: ['ботинки', 'каска'] });
    expect(s.hazards).toEqual(['камнепад', 'высота']);
    expect(s.equipment).toEqual(['ботинки', 'каска']);
  });

  it('отсеивает пустые/не-строковые значения', () => {
    const s = buildSafetyBlock({ ...base, hazards: ['лавины', '', '  '] as string[], equipment: null });
    expect(s.hazards).toEqual(['лавины']);
    expect(s.equipment).toEqual([]);
  });

  it('МЧС и 112 есть всегда — дефолт Камчатки при отсутствии маршрутного', () => {
    const s = buildSafetyBlock(base);
    expect(s.emergencyPhone).toBe('112');
    expect(s.mchsPhone).toContain('4152'); // дефолт ЦУКС Камчатки
  });

  it('маршрутный МЧС-телефон перекрывает дефолт', () => {
    const s = buildSafetyBlock({ ...base, mchsPhone: '+7 (415) 000-00-00' });
    expect(s.mchsPhone).toBe('+7 (415) 000-00-00');
  });

  it('регистрация в МЧС — примечание только когда требуется', () => {
    expect(buildSafetyBlock({ ...base, mchsRegistrationRequired: true }).registrationNote).toContain('регистрац');
    expect(buildSafetyBlock({ ...base, mchsRegistrationRequired: false }).registrationNote).toBeNull();
  });

  it('парк — примечание при наличии', () => {
    expect(buildSafetyBlock({ ...base, parkName: 'Налычево' }).parkNote).toContain('Налычево');
    expect(buildSafetyBlock(base).parkNote).toBeNull();
  });
});
