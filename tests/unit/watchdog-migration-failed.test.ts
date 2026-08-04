/**
 * Watchdog обязан говорить о ПРОВАЛЕ миграции, а не только о «не применённых».
 *
 * Повод (август 2026). Миграция 806 упала на деплое и молчала. Формально её
 * ловил `checkUnappliedMigrations` — упавшая ведь не попадает в `_migrations`.
 * Но «не применены N миграций» читается как задержка деплоя и пролистывается, а
 * причина падения лежала в `_migration_failures` непрочитанной: её не смотрел
 * НИ ОДИН агент.
 *
 * Цена молчания: тур пропал с витрины → отдавал 404 → остался без галереи.
 * Три дня ловли симптомов вместо одной строки «806: column ... does not exist».
 *
 * `start.js` намеренно не роняет деплой при сбое миграции — сервер поднимется в
 * любом случае. Значит сказать об этом может только сторож.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');

describe('watchdog видит упавшие миграции', () => {
  it('читает _migration_failures — раньше её не смотрел никто', () => {
    expect(src).toContain('_migration_failures');
  });

  it('проверка подключена к прогону, а не просто объявлена', () => {
    expect(src).toContain('async function checkFailedMigrations');
    expect(src).toMatch(/checkFailedMigrations\(\),/);
    expect(src).toMatch(/failedMigrations\]/);
  });

  it('у алерта свой тип — иначе сольётся с «не применены»', () => {
    expect(src).toMatch(/'migration_failed'/);
    expect(src).toMatch(/type:\s*'migration_failed'/);
  });

  it('несёт причину падения, а не только имя файла', () => {
    // Без текста ошибки алерт бесполезен: искать придётся всё равно вручную.
    expect(src).toMatch(/SELECT name, error, attempts/);
    expect(src).toMatch(/попыток/);
  });

  it('помечен критичным: код уже раздаётся, а схемы под него нет', () => {
    const fn = src.match(/async function checkFailedMigrations[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/critical:\s*true/);
  });

  it('отсутствие таблицы на свежем окружении не поднимает тревогу', () => {
    const fn = src.match(/async function checkFailedMigrations[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/catch/);
    expect(fn).toMatch(/return null/);
  });

  it('прежняя проверка «не применены» сохранена — они про разное', () => {
    expect(src).toContain('checkUnappliedMigrations');
    expect(src).toMatch(/'migration_unapplied'/);
  });
});
