/**
 * Свободные места — из ЕДИНОГО расчёта занятости, а не из своей арифметики.
 *
 * Находка аудита 08.09: SDK-инструмент `check_availability` считал места как
 * «вместимость тура минус ЧИСЛО всех будущих броней». Ошибка сразу в обе
 * стороны и обе дорогие:
 *
 *   - тур на 12 человек с еженедельными выходами: четыре будущие даты по
 *     десять броней дают 40 > 12, и туристу говорят «мест нет» там, где они
 *     есть — платящего человека разворачивают;
 *   - одна бронь на двенадцать человек в субботу считается ЕДИНИЦЕЙ (там
 *     COUNT(*), а не сумма участников), и туристу обещают одиннадцать мест
 *     на дату, где занято всё.
 *
 * Ни в одном случае число не относилось к КОНКРЕТНОЙ дате, а именно на дату
 * человек и бронирует.
 *
 * Источник правды один и объявлен в шапке lib/kuzmich/tour-availability-tool.ts:
 * «Свой SQL по tour_availability здесь запрещён: разойдётся с гейтом, и агент
 * пообещает места, по которым бронь отклонят». Тот же запрет действует здесь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('lib/agents/sdk/tourist-tools.ts', 'utf8');

describe('занятость: один расчёт на платформу', () => {
  it('используется общий fetchAvailabilityForTour планера', () => {
    expect(SRC).toContain("from '@/lib/planner'");
    expect(SRC).toMatch(/await fetchAvailabilityForTour\(String\(t\.id\)/);
  });

  it('своей арифметики «вместимость минус брони» не осталось', () => {
    expect(SRC).not.toMatch(/slots\s*-\s*booked/);
    expect(SRC).not.toMatch(/AS active_bookings/);
    // И самого подзапроса-счётчика броней тоже.
    expect(SRC).not.toMatch(/SELECT COUNT\(\*\) FROM operator_bookings/);
  });

  it('число мест привязано к дате и это сказано словами', () => {
    expect(SRC).toContain('slots_free_on_next_date');
    expect(SRC).toContain('относится к КОНКРЕТНОЙ дате');
  });

  it('пустое окно — честное «дат нет», а не «мест нет вообще»', () => {
    expect(SRC).toContain('Это реальная занятость по броням');
  });

  it('отказ проверки — третий исход, а не «мест нет»', () => {
    // Якорь — строка ЛОГА, а не описание инструмента: описание тоже
    // содержит слова «доступность тура», и первый indexOf попадал в него.
    const at = SRC.indexOf('`доступность тура ${String(args.tour_id)}`');
    expect(at, 'лог отказа не найден').toBeGreaterThan(0);
    const tail = SRC.slice(at, at + 500);
    expect(tail).toContain("status: 'не_смог'");
    expect(tail).toContain('не говори «мест нет»');
  });
});

describe('вместимость не выдаётся за свободные места', () => {
  it('денормализованная колонка нигде не подписана «свободных мест»', () => {
    // available_slots с бронями не сверяет никто. Подписать её «свободно»
    // значит дать то же обещание, что и сломанный расчёт, только молча.
    expect(SRC).not.toMatch(/\$\{[a-z]\.available_slots\} свободных мест/);
    expect(SRC).not.toMatch(/slots: [a-z]\.available_slots \?/);
  });

  it('вместо этого названа вместимость и указан настоящий инструмент', () => {
    expect(SRC).toMatch(/capacity_hint/);
    expect(SRC).toMatch(/free_places: 'не проверено — спроси check_availability'/);
  });
});
