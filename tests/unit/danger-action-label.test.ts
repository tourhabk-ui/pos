/**
 * Сторож подписи действия зоны (18.10.2026): расчётные 70 и 80 баллов
 * показывались человеку как «Эвакуация (P2)» и «Немедленная эвакуация»,
 * хотя туристов в зонах не было и официальный источник эвакуацию не
 * объявлял. Слово «эвакуация» — только за официальным сообщением.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  actionLabel, displayRecommendedAction, ROUTE_CONTROL_ACTION,
} from '@/lib/safety/action-label';

describe('расчётная оценка эвакуацию не показывает', () => {
  it('EVACUATE_IMMEDIATE без официального источника — контроль маршрутов', () => {
    expect(actionLabel('EVACUATE_IMMEDIATE')).toBe('Требуется контроль маршрутов');
    expect(displayRecommendedAction('EVACUATE_IMMEDIATE')).toBe(ROUTE_CONTROL_ACTION);
  });

  it('EVACUATE_PRIORITY_2 без официального источника — контроль маршрутов', () => {
    expect(actionLabel('EVACUATE_PRIORITY_2')).toBe('Требуется контроль маршрутов');
    expect(displayRecommendedAction('EVACUATE_PRIORITY_2')).toBe(ROUTE_CONTROL_ACTION);
  });

  it('официальная эвакуация своё слово сохраняет', () => {
    expect(actionLabel('EVACUATE_IMMEDIATE', true)).toBe('Немедленная эвакуация');
    expect(actionLabel('EVACUATE_PRIORITY_2', true)).toBe('Эвакуация (P2)');
    expect(displayRecommendedAction('EVACUATE_IMMEDIATE', true)).toBe('EVACUATE_IMMEDIATE');
  });

  it('обычные действия не меняются', () => {
    expect(actionLabel('NORMAL')).toBe('');
    expect(actionLabel('WATCH')).toBe('Наблюдение');
    expect(displayRecommendedAction('WATCH')).toBe('WATCH');
  });

  it('неизвестное действие наружу текстом не уходит', () => {
    expect(actionLabel('SOMETHING_NEW')).toBe('');
  });
});

describe('все поверхности показа идут через общий mapping', () => {
  it('публичный роут и экраны не печатают сырой EVACUATE_*', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/public/danger-summary/route.ts'), 'utf-8');
    const safety = readFileSync(join(process.cwd(), 'app/safety/_SafetyClient.tsx'), 'utf-8');
    const warnings = readFileSync(join(process.cwd(), 'components/safety/SafetyWarnings.tsx'), 'utf-8');
    expect(route).toMatch(/displayRecommendedAction/);
    expect(safety).toMatch(/actionLabel\(/);
    expect(warnings).toMatch(/actionLabel\(/);
    expect(safety).not.toMatch(/'Немедленная эвакуация'/);
  });
});
