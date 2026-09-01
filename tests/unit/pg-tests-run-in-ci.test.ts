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
 * Сторож держит не команду, а СВОЙСТВО: каждый файл `*.pg.test.ts` покрыт тем,
 * что CI запускает. Поимённый список сюда возвращать нельзя — он и был бедой.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

interface CiShape {
  jobs: Record<string, { env?: Record<string, string>; steps: Array<{ run?: string }> }>;
}

const CI = join(process.cwd(), '.github/workflows/ci.yml');
const INTEGRATION = join(process.cwd(), 'tests/integration');

/** Шаги джоба, у которого задан KERNEL_PG_TEST_URL, — только он и может их прогнать. */
function pgJobCommands(): string[] {
  const doc = load(readFileSync(CI, 'utf8')) as CiShape;
  const cmds: string[] = [];
  for (const job of Object.values(doc.jobs)) {
    if (!job.env?.KERNEL_PG_TEST_URL) continue;
    for (const s of job.steps) if (s.run) cmds.push(s.run);
  }
  return cmds;
}

/** Покрывает ли команда CI данный файл: буквальным именем либо глобом. */
function covers(command: string, file: string): boolean {
  if (command.includes(file)) return true;
  for (const m of command.matchAll(/tests\/integration\/\S*?\*\S*/g)) {
    const pattern = m[0].replace(/["']/g, '');
    const re = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '(?:.*/)?')
          .replace(/\*/g, '[^/]*') +
        '$',
    );
    if (re.test(`tests/integration/${file}`)) return true;
  }
  return false;
}

describe('pg-тесты действительно исполняются в CI', () => {
  const files = readdirSync(INTEGRATION).filter((f) => f.endsWith('.pg.test.ts'));

  it('файлы вообще есть — иначе проверка ниже пуста и бессмысленна', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('есть джоб с KERNEL_PG_TEST_URL — без него все pg-тесты пропускаются', () => {
    expect(pgJobCommands().length).toBeGreaterThan(0);
  });

  it.each(files)('%s запускается хотя бы одной командой CI', (file) => {
    const cmds = pgJobCommands();
    expect(
      cmds.some((c) => covers(c, file)),
      `${file} не запускается ничем в ci.yml: он пропускается везде, а сборка при этом зелёная`,
    ).toBe(true);
  });

  it('покрытие держится глобом, а не перечислением имён', () => {
    // Поимённый список молча отстаёт от каталога — так и вышло с тремя
    // файлами. Требование глоба делает отставание невозможным по построению.
    const cmds = pgJobCommands().join('\n');
    expect(cmds, 'команда обязана брать pg-тесты шаблоном').toMatch(/tests\/integration\/\S*\*/);
  });
});
