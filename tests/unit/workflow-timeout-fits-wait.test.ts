/**
 * Сторож: job не может быть короче ожидания, которое он в себе несёт.
 *
 * ── Что случилось 14.09 ────────────────────────────────────────────────────
 *
 * Перепись воронки (`funnel-census.yml`) ждала сборку прода и была отменена по
 * таймауту job'а. В логе последняя строка:
 *
 *   13:49:53  прод на сборке новее нашего коммита ... — содержит наш код
 *   13:49:53  ##[error]The operation was canceled.
 *
 * Ожидание ДОЖДАЛОСЬ и вынесло вердикт — в ту же секунду, когда GitHub снял
 * job. Причина арифметическая: `timeout-minutes: 25` у job'а против 35 минут
 * ожидания внутри него (`ATTEMPTS` 70 x `SLEEP` 30 в `wait-for-deploy.sh`).
 * Ожиданию физически не давали доработать до собственного предела.
 *
 * ── Почему это не мелочь расписания ────────────────────────────────────────
 *
 * У ожидания сборки есть ЧЕСТНЫЙ третий исход: «своей сборки не дождались —
 * это не отказ прода, а „не смогли спросить“» (он так и написан в скрипте).
 * Отмена по таймауту job'а этот исход СТИРАЕТ: cancelled не говорит ни
 * «дождались», ни «не дождались» — он не говорит ничего. То есть короткий
 * таймаут не «обрезает лишнее», а уничтожает единственное место, где прогон
 * мог сказать правду о себе (§4.0).
 *
 * Найдено было не сторожем, а разбором отменённого прогона; сторож заводится,
 * чтобы следующий случай нашёлся до мержа. Тем же замером выяснилось, что
 * коротки были ТРИ workflow, а не один: `model-catalog` (10 минут против 35)
 * и `images-repack` (30).
 *
 * ── Что именно держится ────────────────────────────────────────────────────
 *
 * Не «таймаут ровно 45», а НЕРАВЕНСТВО: таймаут job'а строго больше бюджета
 * ожидания, которое этот job запускает. Бюджет читается из самого скрипта и
 * из переопределений `ATTEMPTS`/`SLEEP` в workflow — вписывать число сюда
 * значило бы завести вторую копию правила, а она разойдётся.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF = join(ROOT, '.github/workflows');
const WAITER = 'scripts/wait-for-deploy.sh';

/** Значения по умолчанию — из самого скрипта, не из памяти. */
function waiterDefaults(): { attempts: number; sleep: number } {
  const src = readFileSync(join(ROOT, WAITER), 'utf-8');
  const attempts = Number(/ATTEMPTS="\$\{ATTEMPTS:-(\d+)\}"/.exec(src)?.[1]);
  const sleep = Number(/SLEEP="\$\{SLEEP:-(\d+)\}"/.exec(src)?.[1]);
  expect(Number.isFinite(attempts), 'ATTEMPTS не прочитан из wait-for-deploy.sh').toBe(true);
  expect(Number.isFinite(sleep), 'SLEEP не прочитан из wait-for-deploy.sh').toBe(true);
  return { attempts, sleep };
}

/**
 * Бюджет ожидания в минутах для конкретного workflow: его собственные
 * `ATTEMPTS`/`SLEEP`, если он их переопределяет, иначе умолчания скрипта.
 */
export function waitBudgetMinutes(yml: string, def: { attempts: number; sleep: number }): number {
  const attempts = Number(/^\s*ATTEMPTS:\s*'?(\d+)'?/m.exec(yml)?.[1]) || def.attempts;
  const sleep = Number(/^\s*SLEEP:\s*'?(\d+)'?/m.exec(yml)?.[1]) || def.sleep;
  return (attempts * sleep) / 60;
}

/** Самый короткий `timeout-minutes` в файле: он и обрежет ожидание первым. */
export function shortestTimeout(yml: string): number | null {
  const all = [...yml.matchAll(/^\s*timeout-minutes:\s*(\d+)/gm)].map((m) => Number(m[1]));
  return all.length > 0 ? Math.min(...all) : null;
}

describe('правило опознаёт случай 14.09', () => {
  const def = { attempts: 70, sleep: 30 };

  it('25 минут при бюджете 35 — коротко', () => {
    const yml = 'jobs:\n  census:\n    timeout-minutes: 25\n    steps:\n      - run: bash scripts/wait-for-deploy.sh\n';
    expect(shortestTimeout(yml)!).toBeLessThan(waitBudgetMinutes(yml, def));
  });

  it('45 минут при бюджете 35 — хватает', () => {
    const yml = 'jobs:\n  census:\n    timeout-minutes: 45\n    steps:\n      - run: bash scripts/wait-for-deploy.sh\n';
    expect(shortestTimeout(yml)!).toBeGreaterThan(waitBudgetMinutes(yml, def));
  });

  it('свой ATTEMPTS считается вместо умолчания', () => {
    // places-osm-crosscheck и соседи ждут дольше: 110 x 30 = 55 минут.
    const yml = 'jobs:\n  x:\n    timeout-minutes: 65\n    steps:\n      - env:\n          ATTEMPTS: \'110\'\n        run: bash scripts/wait-for-deploy.sh\n';
    expect(waitBudgetMinutes(yml, def)).toBe(55);
    expect(shortestTimeout(yml)!).toBeGreaterThan(55);
  });
});

describe('ни один workflow не обрезает своё же ожидание', () => {
  const def = waiterDefaults();
  const files = readdirSync(WF)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .filter((f) => readFileSync(join(WF, f), 'utf-8').includes(WAITER));

  it('workflow с ожиданием сборки найдены', () => {
    // Пустой список означал бы, что сторож зеленеет впустую: путь к скрипту
    // изменился, а проверка продолжает «проходить».
    expect(files.length).toBeGreaterThan(5);
  });

  it('таймаут job строго больше бюджета ожидания', () => {
    const bad: string[] = [];
    for (const f of files) {
      const yml = readFileSync(join(WF, f), 'utf-8');
      const timeout = shortestTimeout(yml);
      if (timeout == null) {
        // Без своего таймаута действует потолок GitHub в 6 часов — ожидание
        // в него влезает с любым разумным бюджетом.
        continue;
      }
      const budget = waitBudgetMinutes(yml, def);
      if (timeout <= budget) {
        bad.push(`${f}: timeout ${timeout} мин <= ожидание ${budget} мин`);
      }
    }
    expect(
      bad,
      'job отменится раньше, чем ожидание успеет вынести вердикт, — и отмена не скажет ничего',
    ).toEqual([]);
  });
});
