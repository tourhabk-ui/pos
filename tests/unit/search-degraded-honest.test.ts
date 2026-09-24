// @vitest-environment node
/**
 * Глобальный поиск: отказ семантики называется, а не глотается (04.09).
 *
 * `catch {}` вокруг semanticSearch делал отказ модели неотличимым от «по
 * смыслу ничего не нашлось» — нарушение §4.0, и единственная настоящая
 * находка внешнего аудита 04.09. Сторож держит: причина в лог и в ответ
 * (`degraded.semantic`), деградированный ответ не кэшируется, внешний
 * catch тоже не молчит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/search/route.ts'), 'utf-8');

describe('/api/search', () => {
  it('в роуте нет немого catch', () => {
    expect(ROUTE).not.toMatch(/catch\s*\{\s*(\/\/[^\n]*\n\s*)*\}/);
  });

  it('отказ семантики — в лог и в ответ третьим состоянием', () => {
    expect(ROUTE).toMatch(/semanticDown = \(err instanceof Error \? err\.message : String\(err\)\)/);
    expect(ROUTE).toMatch(/console\.error\('\[search\] семантический поиск недоступен/);
    expect(ROUTE).toMatch(/degraded: \{ semantic: 'unavailable' as const, reason: semanticDown \}/);
  });

  it('деградированный ответ не кэшируется', () => {
    // 24.09 (аудит П7): у ответа второй вид деградации — отказал один из двух
    // источников (`unavailable`: туры или места). Он тоже не кэшируется: иначе
    // минутный сбой БД раздавался бы как «туров нет» ещё полминуты. Условие
    // расширено, а не ослаблено — семантика по-прежнему ведёт к no-store.
    expect(ROUTE).toMatch(/semanticDown \|\| unavailable\.length > 0 \? 'no-store' : 'public, s-maxage=10/);
  });

  it('внешний отказ поиска тоже назван', () => {
    expect(ROUTE).toMatch(/console\.error\('\[search\] отказ поиска:'/);
  });
});
