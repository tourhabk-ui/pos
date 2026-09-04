// @vitest-environment node
/**
 * Алиасы tsconfig — только живые (04.09).
 *
 * До этого дня в `paths` стояло 51 правило, из них 47 вели в каталог
 * pillars/ с тремя файлами, которые импортировались через `@/pillars/...`
 * и ни одним из этих алиасов. Внешний аудит прочитал это как «архитектуру
 * столпов» — а это был мёртвый конфиг. Сторож держит: у каждого алиаса есть
 * хотя бы один импорт, каталога pillars нет, lib/mcp проверяется tsc, и
 * jest.config.js с теми же алиасами не вернулся.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TSCONFIG = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf-8').replace(/^\s*\/\/.*$/gm, ''));
const PATHS: Record<string, string[]> = TSCONFIG.compilerOptions.paths;

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git' || name === '_archive') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) acc.push(p);
  }
  return acc;
}

const SOURCES = ['app', 'lib', 'components', 'hooks', 'tests', 'scripts']
  .filter((d) => existsSync(join(ROOT, d)))
  .flatMap((d) => walk(join(ROOT, d)))
  .map((p) => readFileSync(p, 'utf-8'));

describe('tsconfig paths', () => {
  it('у каждого алиаса есть импорт', () => {
    const dead = Object.keys(PATHS).filter((alias) => {
      const prefix = alias.replace(/\*$/, '');
      if (prefix === '@/') return false; // корневой, им живёт всё
      return !SOURCES.some((src) => src.includes(`from '${prefix}`) || src.includes(`import('${prefix}`));
    });
    expect(dead, `мёртвые алиасы: ${dead.join(', ')}`).toEqual([]);
  });

  it('ни один алиас не ведёт в pillars, и каталога pillars нет', () => {
    for (const [alias, targets] of Object.entries(PATHS)) {
      expect(targets.join(','), alias).not.toMatch(/pillars/);
    }
    expect(existsSync(join(ROOT, 'pillars'))).toBe(false);
  });

  it('lib/mcp и scripts/ проверяются tsc — исключение из проверки растит фиктивный код', () => {
    // 04.09: в исключённом scripts/ лежал import-osm-geometry.ts с импортом
    // несуществующей функции — его звали пять воркфлоу, и все падали.
    expect(TSCONFIG.exclude).not.toContain('lib/mcp');
    expect(TSCONFIG.exclude).not.toContain('scripts');
  });

  it('jest.config.js с алиасами столпов не вернулся — тесты гоняет vitest', () => {
    expect(existsSync(join(ROOT, 'jest.config.js'))).toBe(false);
  });
});
