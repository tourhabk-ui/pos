/**
 * План поездки называет живые даты туров (#2241).
 *
 * До 08.10 движок плана читал занятость тура (fetchAvailabilityForTour — тот
 * же расчёт, что у get_tour_availability и у гейта брони), а текст плана её
 * выбрасывал: «День 3. Летняя рыбалка — от 28 000 ₽» без даты, без мест и без
 * номера тура. Внешний агент не мог ни назвать дату, ни дойти до заявки.
 *
 * Сторож держит: четыре исхода строки не подменяют друг друга (§4.0), дата,
 * не совпавшая с днём плана, называется честно, и второго метода
 * доступности в инструменте плана нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tourAvailabilityLine, formatTripPlanForChat } from '@/lib/kuzmich/trip-plan-tool';
import type { DayPlan } from '@/lib/planner';

const ROOT = process.cwd();
const TOOL = readFileSync(join(ROOT, 'lib/kuzmich/trip-plan-tool.ts'), 'utf-8');
const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf-8');

const realTour: NonNullable<DayPlan['realTour']> = {
  tourId: '27', operatorName: 'Камчатская рыбалка', operatorSlug: 'ryba', operatorRating: 0,
  tourRating: null, reviewCount: 0, verified: true, maxParticipants: 8,
  weatherDependent: true, durationHours: 10, priceUnit: 'per_person', lodgingIncluded: false,
};

/** 14:05 по Камчатке 07.11 — время проверки мест в фикстурах. */
const CHECKED = '2026-11-07T02:05:00.000Z';

const day = (over: Partial<DayPlan>): DayPlan => ({
  day: 2, type: 'activity' as DayPlan['type'], zone: 'avachinsky', title: 'Летняя рыбалка',
  description: '', activityType: 'fishing', priceFrom: 28000, priceTo: 36000,
  coords: [53.0, 158.6], defaultTransport: 'jeep' as DayPlan['defaultTransport'],
  allowedTransports: ['jeep'] as DayPlan['allowedTransports'], difficulty: 'easy' as DayPlan['difficulty'],
  childFriendly: true, minChildAge: 0, dayWarnings: [], realTour, realPrice: 28000,
  ...over,
});

describe('tourAvailabilityLine: четыре исхода', () => {
  it('дата есть — называется с местами, номером тура и временем проверки', () => {
    const line = tourAvailabilityLine(day({ availability: 'open', availableDate: '2026-10-13', slotsRemaining: 6, availabilityCheckedAt: CHECKED }), '2026-10-13', undefined);
    expect(line).toBe('Тур ID27, Камчатская рыбалка: ближайшая свободная дата в ваши даты — 13.10, свободно мест: 6 (проверено 07.11, 14:05 по Камчатке)');
  });

  it('времени проверки нет — места не подтверждены (совет 07.11, принцип 2)', () => {
    const line = tourAvailabilityLine(day({ availability: 'open', availableDate: '2026-10-13', slotsRemaining: 6 }), '2026-10-13', undefined);
    expect(line).toBe('Тур ID27, Камчатская рыбалка: ближайшая свободная дата в ваши даты — 13.10, свободно мест: 6 (время проверки не записано — места не подтверждены)');
    // Негодное время — то же, что нет времени: не «проверено Invalid Date».
    const bad = tourAvailabilityLine(day({ availability: 'open', availableDate: '2026-10-13', availabilityCheckedAt: 'вчера' }), '2026-10-13', undefined) ?? '';
    expect(bad).toContain('места не подтверждены');
    expect(bad).not.toContain('Invalid');
    // «Мест нет» тоже со временем: места могли освободиться после проверки.
    const none = tourAvailabilityLine(day({ availability: 'none', availabilityCheckedAt: CHECKED }), '2026-10-13', true) ?? '';
    expect(none).toContain('свободных мест нет (проверено 07.11, 14:05 по Камчатке)');
  });

  it('нечем подтвердить места — так и сказано: не прочиталось, расписания нет, календарь не проверился', () => {
    expect(tourAvailabilityLine(day({ availability: 'unread', availabilityCheckedAt: CHECKED }), '2026-10-13', undefined)).toContain('места не подтверждены');
    expect(tourAvailabilityLine(day({ availability: 'none', availabilityCheckedAt: CHECKED }), '2026-10-13', false)).toContain('места не подтверждены');
    expect(tourAvailabilityLine(day({ availability: 'none', availabilityCheckedAt: CHECKED }), '2026-10-13', null)).toContain('места не подтверждены');
  });

  it('дата не совпала с днём плана — сказано вслух, а не выдано за день плана', () => {
    const line = tourAvailabilityLine(day({ availability: 'open', availableDate: '2026-10-15', slotsRemaining: 2 }), '2026-10-13', undefined);
    expect(line).toContain('15.10');
    expect(line).toContain('это не 13.10');
  });

  it('предупреждение о местах движка доходит до текста', () => {
    const line = tourAvailabilityLine(day({
      availability: 'open', availableDate: '2026-10-13', slotsRemaining: 1,
      capacityWarning: 'Свободно 1 из 8 мест, вас 2. Возможно, придётся выбрать другую дату.',
    }), '2026-10-13', undefined);
    expect(line).toContain('вас 2');
  });

  it('расписания нет — «дату подтверждает оператор», а не «мест нет»', () => {
    const line = tourAvailabilityLine(day({ availability: 'none' }), '2026-10-13', false) ?? '';
    expect(line).toContain('расписания в системе нет');
    expect(line).not.toMatch(/свободных мест нет/);
  });

  it('расписание есть, дат в окне нет — «мест нет»', () => {
    const line = tourAvailabilityLine(day({ availability: 'none' }), '2026-10-13', true) ?? '';
    expect(line).toContain('свободных мест нет');
  });

  it('не прочиталось — не «мест нет» и не дата', () => {
    const unread = tourAvailabilityLine(day({ availability: 'unread' }), '2026-10-13', undefined) ?? '';
    expect(unread).toContain('не прочиталась');
    expect(unread).not.toMatch(/мест нет|\d{2}\.\d{2}/);
    // Календарь не проверился — тоже не «мест нет».
    const unknown = tourAvailabilityLine(day({ availability: 'none' }), '2026-10-13', null) ?? '';
    expect(unknown).toContain('не утверждайте, что мест нет');
  });

  it('дня без тура и без чтения занятости строка не касается', () => {
    expect(tourAvailabilityLine(day({ realTour: undefined, availability: 'open', availableDate: '2026-10-13' }), null, undefined)).toBeNull();
    // Продолжение многодневного тура: тур тот же, занятость не читалась.
    expect(tourAvailabilityLine(day({ availability: undefined }), null, undefined)).toBeNull();
  });
});

describe('formatTripPlanForChat: живая дата под днём тура', () => {
  it('дата дня плана считается от первого дня, строка стоит под днём', () => {
    const text = formatTripPlanForChat(
      [day({ day: 2, availability: 'open', availableDate: '2026-10-13', slotsRemaining: 6, availabilityCheckedAt: CHECKED })],
      [], null,
      { refusal: '', plannedFor: '12 октября', arrivalIso: '2026-10-12' },
    );
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('День 2.'));
    expect(lines[at + 1]).toBe('   Тур ID27, Камчатская рыбалка: ближайшая свободная дата в ваши даты — 13.10, свободно мест: 6 (проверено 07.11, 14:05 по Камчатке)');
  });

  it('расписание тура берётся из переданной карты по ID', () => {
    const text = formatTripPlanForChat(
      [day({ availability: 'none' })], [], null,
      { refusal: '', plannedFor: '12 октября', arrivalIso: '2026-10-12', keepsSchedule: new Map([['27', false]]) },
    );
    expect(text).toContain('Тур ID27, Камчатская рыбалка: расписания в системе нет');
  });
});

describe('источник один: занятость движка, а не второй метод', () => {
  it('движок записывает исход чтения занятости у дня с туром', () => {
    expect(ENGINE).toMatch(/availability = slots === null \? 'unread' : daySlot \? 'open' : 'none';/);
    expect(ENGINE).toMatch(/availableDate,\s*slotsRemaining,\s*availability,/);
  });

  it('инструмент плана не читает tour_availability сам и не зовёт свой расчёт мест', () => {
    const code = TOOL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/FROM\s+tour_availability|fetchAvailabilityForTour\(|pool\.query/);
    // Календарь — общим вопросом сервиса заявок, тем же, что у get_tour_availability.
    expect(TOOL).toMatch(/import \{ tourKeepsSchedule \} from '@\/lib\/seat-requests\/service'/);
    expect(TOOL).toMatch(/d\.availability === 'none'/);
  });

  it('обработчик передаёт в текст дату первого дня и карту расписаний', () => {
    expect(TOOL).toMatch(/arrivalIso: arrival\.toISOString\(\)\.slice\(0, 10\), keepsSchedule,/);
  });
});
