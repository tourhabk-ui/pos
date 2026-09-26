/**
 * Трекер визитов хаба безопасности удалён и не возвращается.
 *
 * ── Повод: объявленный исход без источника И без потребителя (§10.09) ──────
 *
 * `POST /api/safety/visit` обещал шапкой «Публичный лёгкий трекинг визитов
 * хаба безопасности для Rescue агента». Не работало ни одно слово:
 *
 *   - «публичный» — в реестре `lib/auth/public-api-routes.ts` роута не было,
 *     значит Edge отвечал анониму 401; проверено живым запросом со страницы
 *     `/hub/safety`, которая ПУБЛИЧНА;
 *   - «трекинг» — вызов в `_SafetyHubClient` глушился `.catch(() => {})`, и
 *     401 был снаружи неотличим от записи;
 *   - «для Rescue агента» — строки `safety_hub_visit` не читал НИКТО: во всём
 *     репозитории единственным вхождением был сам INSERT.
 *
 * Такое не «чинят на будущее»: механизма не существовало, а описание
 * заставляло верить, что посещаемость хаба измеряется. Понадобится счёт визитов
 * — он заводится вместе с читателем и с записью в реестре публичных, одним PR.
 *
 * Сторож держит обе половины: и роут не вернулся, и вызова к нему нет.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const SOURCES = [
  ...walk(join(root, 'app')),
  ...walk(join(root, 'lib')),
  ...walk(join(root, 'components')),
  ...walk(join(root, 'hooks')),
];

/** Код без комментариев: разбор случая цитирует удалённое по имени. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('трекер визитов хаба безопасности удалён', () => {
  it('роута нет на диске', () => {
    expect(existsSync(join(root, 'app/api/safety/visit/route.ts'))).toBe(false);
    expect(existsSync(join(root, 'app/api/safety/visit'))).toBe(false);
  });

  it('никто его не зовёт', () => {
    const callers = SOURCES.filter((f) => codeOf(f).includes('/api/safety/visit'))
      .map((f) => f.replace(root + '/', ''));
    expect(
      callers,
      'вызов удалённого роута: он отвечал бы 404, а ответ по-прежнему никто не читает',
    ).toEqual([]);
  });

  it('записи safety_hub_visit больше никто не пишет', () => {
    const writers = SOURCES.filter((f) => codeOf(f).includes('safety_hub_visit'))
      .map((f) => f.replace(root + '/', ''));
    expect(
      writers,
      'вернулся писатель safety_hub_visit. Строка, которую никто не читает, — '
      + 'объявленный исход без потребителя (§10.09): заводите счёт вместе с читателем',
    ).toEqual([]);
  });

  it('в реестре публичных роутов его тоже нет', () => {
    const registry = readFileSync(join(root, 'lib/auth/public-api-routes.ts'), 'utf-8');
    expect(registry).not.toContain('/api/safety/visit');
  });

  it('из списка «проверку не нашли» строка вычеркнута вместе с удалением', () => {
    const inventory = readFileSync(join(root, 'tests/unit/route-inventory.test.ts'), 'utf-8');
    const code = inventory
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain("'/api/safety/visit'");
  });
});
