/**
 * Тест на настоящем PostgreSQL, которого CI не запускает, — это не тест.
 *
 * ── Что случилось 01.09 ────────────────────────────────────────────────────
 *
 * Джоб `kernel-pg` в ci.yml поднимает postgres:16 и задаёт KERNEL_PG_TEST_URL,
 * а запускал ОДИН файл по имени — `tests/integration/agent-kernel.pg.test.ts`,
 * как было при его заведении. К этому дню рядом лежало ещё три `*.pg.test.ts`,
 * и ни один из них CI не исполнял НИ РАЗУ: в джобе `ci` переменной нет и они
 * уходят в skip, а в `kernel-pg` они не попадали. Пропуск выглядит успехом —
 * третий исход, выданный за первый (§4.0).
 *
 * ── Где живёт настоящее доказательство ─────────────────────────────────────
 *
 * В `scripts/ci/run-pg-tests.sh`: он объявляет селектор один раз, спрашивает
 * сам vitest, что тот выберет, сверяет с каталогом и только потом запускает.
 * Это execution тем же механизмом, который выбирает в CI.
 *
 * Раньше та же проверка стояла ЗДЕСЬ и запускала второй vitest изнутри
 * прогона. Локально это стоило 1.3 с, а на двухъядерном раннере шаг «Run
 * tests» встал: 25+ минут против семи, при том что всё до него заняло пять.
 * Проверка, из-за которой прогон не заканчивается, ничего не проверяет — она
 * его заменяет. Гнездование убрано, вопрос задаётся снаружи и один раз.
 *
 * Здесь остаётся дешёвая связка: джоб с переменной существует и зовёт именно
 * тот скрипт. Это ФОРМА, и я это называю прямо — но форма тут не подменяет
 * проверку, а указывает на неё: сам скрипт краснеет в CI на каждой сборке.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

interface CiShape {
  jobs: Record<string, { env?: Record<string, string>; steps: Array<{ run?: string }> }>;
}

const CI = join(process.cwd(), '.github/workflows/ci.yml');
const SCRIPT = 'scripts/ci/run-pg-tests.sh';
const INTEGRATION = join(process.cwd(), 'tests/integration');

/** Шаги джоба, у которого задан KERNEL_PG_TEST_URL, — только он и может прогнать pg-тесты. */
function pgJobCommands(): string[] {
  const doc = load(readFileSync(CI, 'utf8')) as CiShape;
  const cmds: string[] = [];
  for (const job of Object.values(doc.jobs)) {
    if (!job.env?.KERNEL_PG_TEST_URL) continue;
    for (const s of job.steps) if (s.run) cmds.push(s.run.trim());
  }
  return cmds;
}

describe('pg-тесты доходят до CI', () => {
  it('файлы вообще есть — иначе проверка ниже пуста и бессмысленна', () => {
    expect(readdirSync(INTEGRATION).filter((f) => f.endsWith('.pg.test.ts')).length).toBeGreaterThan(0);
  });

  it('есть джоб с KERNEL_PG_TEST_URL — без него все pg-тесты пропускаются', () => {
    expect(pgJobCommands().length).toBeGreaterThan(0);
  });

  it('этот джоб зовёт скрипт, который сверяет выборку с каталогом', () => {
    expect(
      pgJobCommands().some((c) => c.includes(SCRIPT)),
      `pg-джоб обязан идти через ${SCRIPT}: он краснеет на пустой выборке, а голый vitest — нет`,
    ).toBe(true);
    expect(existsSync(join(process.cwd(), SCRIPT))).toBe(true);
  });

  it('скрипт держит селектор и сверку, а не просто запускает', () => {
    const src = readFileSync(join(process.cwd(), SCRIPT), 'utf8');
    expect(src).toContain('vitest list --filesOnly');
    expect(src, 'пустая выборка обязана быть приговором').toContain('не выбрал ни одного файла');
    expect(src, 'недостающий файл обязан быть приговором').toContain('пропускаются везде');
  });

  it('pg-тесты идут последовательно — база у них одна', () => {
    // Файлы делят таблицы в одной базе: safety-ledger пишет в
    // safety_decision_events, а ledger-check-recent-order дропает её в afterAll.
    // Параллельно это гонка (замер: 2 успеха из 3 против 9 из 9).
    expect(
      readFileSync(join(process.cwd(), SCRIPT), 'utf8'),
      'без --no-file-parallelism прогон флапает по чужому дропу таблицы',
    ).toContain('--no-file-parallelism');
  });

  /**
   * Граница размена живёт здесь, а не в чужой памяти.
   *
   * Последовательность выбрана вместо изоляции по схемам при конкретных
   * условиях: файлов четыре, весь прогон около трёх секунд. Условия не вечные.
   * Когда файлов станет заметно больше, последовательный прогон вырастет, и
   * кто-то вернёт параллельность — не зная, что она уже воскрешала гонку за
   * `safety_decision_events` и что зелёный прогон 01.09 был зелёным по удаче.
   *
   * Порог не запрещает расти. Он заставляет того, кто перешагнёт, ПРИНЯТЬ
   * решение вслух: либо поднять число здесь, подтвердив, что размен всё ещё
   * честен, либо завести настоящую изоляцию (схема на файл) и снять
   * последовательность. Тот же приём, что у замороженных реестров (§8 D2,
   * #1304): рост беды дороже, чем осознанная запись о ней.
   */
  it('число pg-файлов не переросло размен «последовательно вместо изоляции»', () => {
    const SEQUENTIAL_BUDGET = 6;
    const count = readdirSync(INTEGRATION).filter((f) => f.endsWith('.pg.test.ts')).length;
    expect(
      count,
      `pg-файлов ${count} при пороге ${SEQUENTIAL_BUDGET}. Последовательный прогон был дёшев на четырёх файлах; ` +
        'решите ЯВНО: поднять порог здесь (размен ещё честен) или дать каждому файлу свою схему и вернуть ' +
        'параллельность. Молча вернуть параллельность нельзя — она воскрешает гонку за safety_decision_events.',
    ).toBeLessThanOrEqual(SEQUENTIAL_BUDGET);
  });
});
