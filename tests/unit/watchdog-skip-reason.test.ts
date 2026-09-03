// @vitest-environment node
/**
 * Watchdog называет причину своего «partial» (02.09).
 *
 * Детектор бесплодных кронов (cron-fruitless) 02.09 пометил самого
 * Watchdog: «47 прогонов подряд без результата, причина пропуска не
 * записана». Причина была — проверка checkPendingTransferBookings падала на
 * отсутствующей таблице (миграция 926 не применялась), и Watchdog честно
 * писал `partial`, — но в общий ключ `skip_reason`, который детектор читает у
 * любого крона, он её не клал. Отчёт называл класс беды и молчал о самой
 * беде: «без результата» вместо «не смогла проверка X».
 *
 * Сторож: при partial в metadata пишется `skip_reason` с именами проверок.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/watchdog/route.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('watchdog: причина partial доезжает до детектора', () => {
  it('в metadata прогона есть общий ключ skip_reason', () => {
    expect(ROUTE).toMatch(/skip_reason:\s*failedChecks > 0/);
  });
  it('причина — имена проверок, которые не выполнились', () => {
    const at = ROUTE.indexOf('skip_reason:');
    expect(ROUTE.slice(at, at + 200)).toMatch(/result\.checks\.failed\.map\(f => f\.check\)/);
  });
});
