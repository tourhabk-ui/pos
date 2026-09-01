/**
 * Тест на настоящем PostgreSQL, которого CI не запускает, — это не тест.
 *
 * ── Что случилось 01.09 ────────────────────────────────────────────────────
 *
 * Джоб `kernel-pg` в ci.yml поднимает postgres:16 и задаёт KERNEL_PG_TEST_URL,
 * а запускал ОДИН файл по имени — `tests/integration/agent-kernel.pg.test.ts`,
 * как было при его заведении. К этому дню рядом лежало ещё три `*.pg.test.ts`
 * (append-only ledger, порядок «последних» событий, перепись реестра схемы), и
 * ни один из них CI не исполнял НИ РАЗУ:
 *
 *   - в джобе `ci` переменной KERNEL_PG_TEST_URL нет, и файлы уходят в skip;
 *   - в джобе `kernel-pg` переменная есть, но файлы туда не попадали.
 *
 * Пропуск при этом выглядит как успех: сборка зелёная, тестов «прошло N».
 * Ровно третий исход, выданный за первый (§4.0) — и особенно дорогой здесь,
 * потому что pg-тесты заводятся именно для того, что статикой не судится
 * (прецедент 42P08 в CLAUDE.md: вывод типов и разрешение имён делает сервер).
 *
 * ── Почему сторож исполняет команду, а не читает её ────────────────────────
 *
 * Первая версия этого сторожа проверяла ФОРМУ: «в команде есть шаблон по
 * tests/integration». Форма была, и она прошла — а команда
 * `vitest run "tests/integration/**\/*.pg.test.ts"` не выбирает НИ ОДНОГО
 * файла: позиционный аргумент vitest это подстрока пути, а не glob. Джоб упал
 * за 51 секунду на первом же прогоне в CI.
 *
 * Отсюда правило: спрашиваем сам vitest, что он выберет по аргументам из
 * ci.yml (`vitest list --filesOnly`), и сверяем с каталогом. Свойство —
 * «каждый pg-тест попадает в выборку CI», и доказывается оно тем же
 * инструментом, который будет выбирать в CI.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { load } from 'js-yaml';

interface CiShape {
  jobs: Record<string, { env?: Record<string, string>; steps: Array<{ run?: string }> }>;
}

const CI = join(process.cwd(), '.github/workflows/ci.yml');
const INTEGRATION = join(process.cwd(), 'tests/integration');

/** Шаги джоба, у которого задан KERNEL_PG_TEST_URL, — только он и может прогнать pg-тесты. */
function pgJobCommands(): string[] {
  const doc = load(readFileSync(CI, 'utf8')) as CiShape;
  const cmds: string[] = [];
  for (const job of Object.values(doc.jobs)) {
    if (!job.env?.KERNEL_PG_TEST_URL) continue;
    for (const s of job.steps) if (s.run?.includes('vitest')) cmds.push(s.run.trim());
  }
  return cmds;
}

/**
 * Что vitest РЕАЛЬНО выберет по аргументам команды CI.
 *
 * Аргументы берутся из самой команды: подменять их своими значило бы стеречь
 * не ту команду, которая поедет. `run` заменяется на `list --filesOnly` —
 * выбор файлов делает тот же механизм, а тесты не исполняются.
 */
function filesSelectedBy(command: string): string[] {
  const args = command
    .replace(/^npx\s+vitest\s+run\s*/, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((a) => a.replace(/^["']|["']$/g, ''));

  const out = execFileSync('npx', ['vitest', 'list', '--filesOnly', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.test.ts') || l.endsWith('.test.tsx'));
}

describe('pg-тесты действительно исполняются в CI', () => {
  const files = readdirSync(INTEGRATION).filter((f) => f.endsWith('.pg.test.ts'));

  it('файлы вообще есть — иначе проверка ниже пуста и бессмысленна', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('есть джоб с KERNEL_PG_TEST_URL — без него все pg-тесты пропускаются', () => {
    expect(pgJobCommands().length).toBeGreaterThan(0);
  });

  it('vitest по аргументам CI выбирает КАЖДЫЙ pg-тест', () => {
    const selected = new Set(pgJobCommands().flatMap(filesSelectedBy));

    expect(
      selected.size,
      'команда CI не выбирает ни одного файла: она выглядит рабочей, но джоб упадёт «нет тестов»',
    ).toBeGreaterThan(0);

    const missed = files.filter((f) => ![...selected].some((s) => s.endsWith(f)));
    expect(
      missed,
      `эти pg-тесты не попадают в выборку CI и пропускаются везде: ${missed.join(', ')}`,
    ).toEqual([]);
  });
}, 120_000);
