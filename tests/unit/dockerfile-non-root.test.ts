/**
 * Сторож: процесс в runner-образе работает не от root (25.09).
 *
 * До этого дня в стадии runner не было ни одной строки USER — `node start.js`
 * и сервер Next шли от root. Уязвимость в любой зависимости давала
 * злоумышленнику root внутри контейнера, а не бесправного пользователя.
 *
 * Держится связка целиком: USER без прав на запись сломал бы загрузки и кэш
 * Next (они пишут под /app), а права без USER ничего не меняют.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf-8');
const RUNNER = DOCKERFILE.slice(DOCKERFILE.indexOf('AS runner'));

describe('runner-образ не от root', () => {
  it('стадия runner найдена — иначе сторож стерёг бы пустоту', () => {
    expect(DOCKERFILE.indexOf('AS runner')).toBeGreaterThan(0);
  });

  it('последний USER в runner — не root, и стоит до CMD', () => {
    const users = [...RUNNER.matchAll(/^USER\s+(\S+)/gm)];
    expect(users.length).toBeGreaterThan(0);
    const last = users[users.length - 1];
    expect(last[1]).not.toMatch(/^(root|0)(:|$)/);
    expect(RUNNER.indexOf(last[0])).toBeLessThan(RUNNER.indexOf('CMD'));
  });

  it('каждый COPY в runner отдаёт файлы тому же пользователю', () => {
    const user = [...RUNNER.matchAll(/^USER\s+(\S+)/gm)].pop()![1];
    const copies = RUNNER.split('\n').filter((l) => /^COPY\s/.test(l));
    expect(copies.length).toBeGreaterThan(0);
    for (const line of copies) expect(line, line).toContain(`--chown=${user}:`);
  });

  it('права раздаются на COPY, а не рекурсивным chown отдельным слоем (лимит 50 МБ)', () => {
    const runs = RUNNER.split('\n').filter((l) => /^RUN\s/.test(l));
    for (const line of runs) expect(line, line).not.toMatch(/chown\s+-R/);
  });

  it('сама /app принадлежит тому же пользователю', () => {
    const user = [...RUNNER.matchAll(/^USER\s+(\S+)/gm)].pop()![1];
    expect(RUNNER).toMatch(new RegExp(`^RUN chown ${user}:${user} /app$`, 'm'));
  });
});
