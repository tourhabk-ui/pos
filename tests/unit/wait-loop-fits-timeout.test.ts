/**
 * Ожидание сборки должно помещаться в таймаут джоба.
 *
 * 18.08 перепись версии 6 была убита на 10-й минуте, пока ждала прод: в
 * workflow стоял `timeout-minutes: 10`, а цикл ожидания рассчитан на 30 минут.
 * Такой прогон не может завершиться НИКОГДА — он гарантированно умирает в
 * ожидании.
 *
 * Хуже способа умереть не придумаешь: GitHub показывает убитый по таймауту
 * джоб как «cancelled», то есть как чьё-то решение. Я и искал сначала, кто его
 * отменил.
 *
 * Та же мина лежала в уборке (15 минут против 30 ожидания) и не сработала
 * только потому, что прод собрался быстро.
 *
 * Сторож считает арифметику вместо человека: попыток × пауза должно быть
 * меньше таймаута.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Workflow, которые ждут появления своего кода на проде. */
const WAITERS = [
  '.github/workflows/route-data-audit.yml',
  '.github/workflows/route-links-repair.yml',
  '.github/workflows/route-track-reconcile.yml',
];

describe('прогон способен дождаться того, чего ждёт', () => {
  for (const path of WAITERS) {
    it(`${path.split('/').pop()}: ожидание помещается в таймаут`, () => {
      const src = read(path);

      const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(src)?.[1] ?? 0);
      expect(timeout, 'у джоба нет таймаута — висяк не ограничен ничем').toBeGreaterThan(0);

      // Цикл вида `for i in $(seq 1 30)` + `sleep 60`.
      const attempts = Number(/seq 1 (\d+)/.exec(src)?.[1] ?? 0);
      const sleepSec = Number(/sleep (\d+)/.exec(src)?.[1] ?? 0);
      expect(attempts, 'цикл ожидания не найден').toBeGreaterThan(0);

      const waitMin = (attempts * sleepSec) / 60;
      expect(
        timeout,
        `ожидание ${waitMin} мин не помещается в таймаут ${timeout} мин — прогон умрёт, не дождавшись`,
      ).toBeGreaterThan(waitMin);
    });
  }
});
