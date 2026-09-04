// @vitest-environment node
/**
 * Скрипты, которые зовут воркфлоу, существуют и проверяются (04.09).
 *
 * scripts/ был исключён из tsconfig, и в нём месяцами лежал
 * import-osm-geometry.ts с импортом функции, которой в раннере нет: любой
 * запуск падал на первой строке, а красный прогон читался как «база не
 * пустила» (последние прогоны 10.07 и правда падали на доступе к БД).
 * Исключение из проверки — слепая зона, в которой растёт фиктивный код.
 *
 * Сторож держит три вещи: путь к скрипту из воркфлоу (вне комментариев)
 * ведёт к файлу; .ts-скрипты не исключены из tsc; у .js/.mjs-скриптов, до
 * которых tsc не дотягивается, локальные импорты разрешаются в файлы.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';

const ROOT = process.cwd();
const WF_DIR = join(ROOT, '.github', 'workflows');

function referencedScripts(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(WF_DIR).filter((x) => /\.ya?ml$/.test(x))) {
    for (const line of readFileSync(join(WF_DIR, f), 'utf-8').split('\n')) {
      if (line.trimStart().startsWith('#')) continue; // шапки — не вызов
      for (const m of line.matchAll(/scripts\/[A-Za-z0-9._/-]+\.(?:ts|mjs|js|cjs)/g)) {
        const list = out.get(m[0]) ?? [];
        if (!list.includes(f)) list.push(f);
        out.set(m[0], list);
      }
    }
  }
  return out;
}

const SCRIPTS = referencedScripts();

describe('скрипты воркфлоу', () => {
  it('перепись не пуста — воркфлоу и правда зовут скрипты', () => {
    expect(SCRIPTS.size).toBeGreaterThan(10);
  });

  it('каждый путь ведёт к файлу', () => {
    const missing = [...SCRIPTS].filter(([p]) => !existsSync(join(ROOT, p)));
    expect(missing.map(([p, wfs]) => `${p} ← ${wfs.join(', ')}`), 'воркфлоу зовёт несуществующий скрипт').toEqual([]);
  });

  it('.ts-скрипты — под tsc: scripts не в exclude tsconfig', () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf-8').replace(/^\s*\/\/.*$/gm, ''));
    expect(tsconfig.exclude).not.toContain('scripts');
    expect(tsconfig.include).toContain('**/*.ts');
  });

  it('у .js/.mjs-скриптов локальные импорты разрешаются в файлы', () => {
    const bad: string[] = [];
    for (const [p] of SCRIPTS) {
      if (!/\.(?:mjs|js|cjs)$/.test(p) || !existsSync(join(ROOT, p))) continue;
      const src = readFileSync(join(ROOT, p), 'utf-8');
      for (const m of src.matchAll(/(?:require\(|from\s+|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const base = normalize(join(ROOT, dirname(p), m[1]));
        const ok = ['', '.js', '.mjs', '.cjs', '.ts', '/index.js', '/index.ts'].some((ext) => existsSync(base + ext));
        if (!ok) bad.push(`${p}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
