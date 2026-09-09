/**
 * Линтер, которого никто не запускает, — не инструмент, а файл конфигурации.
 *
 * До 09.09 `eslint` не вызывался НИГДЕ: ни в одном workflow, ни в
 * .husky/pre-commit. Конфиг при этом был подробный, с обдуманными
 * переопределениями и записанными причинами — и ровно поэтому вреден:
 * он создавал впечатление, что за этот класс дефектов кто-то отвечает,
 * и под него не писали сторожей. Молчащая проверка читается как
 * «нарушений нет» (§4.0) — третий исход выдавался за первый.
 *
 * Цена измерена в тот же день. На main лежало 8 ошибок и 309
 * предупреждений, невидимых три недели. А в самом eslint.config.mjs
 * записано, что правила эры React Compiler дают «167 срабатываний» и
 * понижены до `warn`, чтобы «держать на виду в каждом прогоне» под
 * issue #885. На 09.09 их 223: за время под `warn` без прогонов их стало
 * на 56 больше. Понижение до warn работает только там, где warn читают.
 *
 * Сторож держит два решения владельца, а не стиль кода.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const CI = read('.github/workflows/ci.yml');
const PKG = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

/**
 * Тело job'а по имени: от `  <имя>:` до следующего ключа той же вложенности.
 *
 * Комментарии из тела вырезаются. Иначе сторож судит по объяснениям, а не по
 * командам: первая версия этой проверки нашла слово «eslint» в шапке, которая
 * рассказывает, ПОЧЕМУ линта в этом job'е нет, и объявила его присутствующим.
 */
function jobBody(yaml: string, name: string): string {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  if (start === -1) return '';
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  return body.replace(/^\s*#.*$/gm, '');
}

describe('линтер вызывается в CI', () => {
  it('в ci.yml есть job lint, и он зовёт npm run lint', () => {
    const lint = jobBody(CI, 'lint');
    expect(lint).not.toBe('');
    expect(lint).toMatch(/npm run lint/);
  });

  it('скрипт lint зовёт eslint напрямую', () => {
    // `next lint` удалён в Next 16 — вызов должен быть свой, иначе job
    // покраснеет не на нарушениях, а на отсутствующей команде.
    expect(PKG.scripts.lint).toMatch(/(^|\s)eslint(\s|$)/);
    expect(PKG.scripts.lint).not.toMatch(/next lint/);
  });
});

describe('линт идёт отдельной дорожкой и ничего не заслоняет', () => {
  it('в job ci линта нет — иначе он падал бы раньше tsc и тестов', () => {
    // Тот же урок, что стоил пяти часов прода 15.08 на счётчиках README
    // (tests/unit/ci-does-not-block-on-stats.test.ts): проверка, падающая
    // первой, не даёт выполниться настоящим. Косметическое нарушение не
    // должно прятать поломку типов или красный тест.
    expect(jobBody(CI, 'ci')).not.toMatch(/npm run lint|eslint /);
  });

  it('настоящие проверки в job ci на месте', () => {
    const ci = jobBody(CI, 'ci');
    expect(ci).toMatch(/tsc --noEmit/);
    expect(ci).toMatch(/vitest run/);
  });
});

describe('предупреждения печатаются, а не роняют прогон', () => {
  it('порога --max-warnings нет, пока их 309', () => {
    // Поставить 0 сегодня — значит завести вечно красный main, а вечно
    // красную проверку начинают обходить, и она перестаёт что-либо значить.
    // Порог ставится, когда счёт дойдёт до нуля по #885, а не раньше.
    expect(jobBody(CI, 'lint')).not.toMatch(/--max-warnings/);
    expect(PKG.scripts.lint).not.toMatch(/--max-warnings/);
  });
});
