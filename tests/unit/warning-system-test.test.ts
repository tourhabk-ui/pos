/**
 * Сторож: плановая проверка систем оповещения (#1428, решение владельца 08.10).
 *
 * Объявление МЧС о проверке сирен доходит до туриста заранее — тревогой
 * `warning_test` с severity 0: она видна в ленте и у агентов, но не меняет
 * статус края, вердикт маршрута и не шлёт пуш. Отчёт о прошедшей проверке в
 * ленту не идёт. Руководство говорит про ВРЕМЯ: вне объявленного окна сирена
 * настоящая.
 */
import { describe, it, expect } from 'vitest';
import { warningSystemTest, warningTestHours, WARNING_TEST_FALLBACK_HOURS } from '@/lib/safety/warning-system-test';
import { classifyMchsItem } from '@/lib/services/safety/seismic-parser';
import { FEED_ALERT_TYPES } from '@/lib/services/safety/feed-types';
import { alertGuidance } from '@/lib/safety/alert-guidance';

const PLANNED = '7 октября с 10:40 до 10:50 на территории Камчатского края пройдёт комплексная проверка готовности '
  + 'региональной автоматизированной системы централизованного оповещения населения. Будут включены электросирены '
  + 'и передан сигнал «Внимание всем!». Просим жителей и гостей края сохранять спокойствие.';
const IN_DRILL = 'В рамках командно-штабной тренировки 15 октября в 11:00 будет проведена проверка муниципальной системы '
  + 'оповещения в Петропавловске-Камчатском: прозвучат сирены.';
const REPORT = 'Сегодня на Камчатке прошла комплексная проверка системы оповещения населения. Сирены сработали штатно.';
const DRILL_ONLY = 'В школе № 40 прошло пожарно-тактическое учение: эвакуировано 600 человек.';

describe('распознавание', () => {
  it('объявление проверки — planned, отчёт — report, прочее — null', () => {
    expect(warningSystemTest(PLANNED)).toBe('planned');
    expect(warningSystemTest(IN_DRILL)).toBe('planned');
    expect(warningSystemTest(REPORT)).toBe('report');
    expect(warningSystemTest(DRILL_ONLY)).toBeNull();
    expect(warningSystemTest('Сильный ветер до 25 м/с ожидается 9 октября')).toBeNull();
  });
});

describe('срок объявления', () => {
  const pub = new Date('2026-10-05T22:00:00Z'); // 06.10 10:00 по Камчатке

  it('до конца названного дня по Камчатке (12:00 UTC того же числа)', () => {
    expect(warningTestHours(PLANNED, pub)).toBe(38); // до 07.10 12:00 UTC
  });

  it('«сегодня» и «завтра» — от дня публикации по Камчатке', () => {
    expect(warningTestHours('сегодня в 10:40 пройдёт проверка системы оповещения', pub)).toBe(14);
    expect(warningTestHours('завтра пройдёт проверка системы оповещения', pub)).toBe(38);
  });

  it('день уже прошёл — null; даты нет или она дальше двух недель — запасной срок', () => {
    expect(warningTestHours('3 октября пройдёт проверка', pub)).toBeNull();
    expect(warningTestHours('пройдёт проверка системы оповещения', pub)).toBe(WARNING_TEST_FALLBACK_HOURS);
    expect(warningTestHours('25 ноября пройдёт проверка', pub)).toBe(WARNING_TEST_FALLBACK_HOURS);
  });
});

describe('классификатор МЧС', () => {
  it('объявление — warning_test, severity 0, срок до дня проверки', () => {
    const e = classifyMchsItem('mchs/siren-1', '', PLANNED, '2026-10-05T22:00:00Z', 'https://41.mchs.gov.ru/item/s1');
    expect(e?.alert_type).toBe('warning_test');
    expect(e?.severity).toBe(0);
    expect(e?.expires_hours).toBe(38);
  });

  it('проверка «в рамках тренировки» не выбрасывается фильтром учений', () => {
    const e = classifyMchsItem('mchs/siren-2', '', IN_DRILL, '2026-10-13T22:00:00Z', 'https://41.mchs.gov.ru/item/s2');
    expect(e?.alert_type).toBe('warning_test');
  });

  it('отчёт о прошедшей проверке и обычное учение в ленту не идут', () => {
    expect(classifyMchsItem('mchs/siren-3', '', REPORT, '2026-10-07T03:00:00Z', 'https://41.mchs.gov.ru/item/s3')).toBeNull();
    expect(classifyMchsItem('mchs/drill', '', DRILL_ONLY, '2026-10-07T03:00:00Z', 'https://41.mchs.gov.ru/item/d')).toBeNull();
  });

  it('пороги «запрет туристам» и «разряд ОЯ» не поднимают проверку до опасности', () => {
    const text = `${PLANNED} Туристам рекомендуется воздержаться от выхода на маршруты в это время.`;
    const e = classifyMchsItem('mchs/siren-4', '', text, '2026-10-05T22:00:00Z', 'https://41.mchs.gov.ru/item/s4');
    expect(e?.alert_type).toBe('warning_test');
    expect(e?.severity).toBe(0);
  });
});

describe('где видно', () => {
  it('в ленте, с руководством о границе по времени', () => {
    expect((FEED_ALERT_TYPES as readonly string[]).includes('warning_test')).toBe(true);
    const g = alertGuidance('warning_test');
    expect(g.known).toBe(true);
    expect(g.steps.join(' ')).toMatch(/в объявленное время/i);
    expect(g.steps.join(' ')).toMatch(/в другое время — настоящий сигнал/);
  });
});
