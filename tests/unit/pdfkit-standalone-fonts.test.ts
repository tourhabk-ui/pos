// @vitest-environment node
/**
 * PDF на проде: шрифты pdfkit обязаны попасть в standalone-сборку.
 *
 * Скрин владельца 11.10: /api/leads/<id>/proposal/pdf ответил «Cannot find
 * module '#standard-fonts/Helvetica'». С pdfkit 0.20 стандартные шрифты —
 * модули, которые узел находит по полю "imports" в package.json пакета
 * (`#standard-fonts/*` → `./js/standard-fonts/*.cjs`). Трассировка Next
 * standalone такой require по шаблону не видит, и каталога в образе не было,
 * а в next.config.js стоял только прежний js/data.
 *
 * Сторож не держит список руками: он читает поле "imports" УСТАНОВЛЕННОГО
 * pdfkit и требует, чтобы каждый каталог, на который указывает подпутевой
 * импорт шрифтов, был включён в outputFileTracingIncludes. Обновят пакет и
 * сменится путь — красный до деплоя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const PDFKIT = join(ROOT, 'node_modules/pdfkit');
const pkg = JSON.parse(readFileSync(join(PDFKIT, 'package.json'), 'utf8')) as { version: string; imports?: Record<string, unknown> };
const nodeBuild = readFileSync(join(PDFKIT, 'js/pdfkit.node.mjs'), 'utf8');

const require = createRequire(import.meta.url);
const config = require(join(ROOT, 'next.config.js')) as { outputFileTracingIncludes?: Record<string, string[]> };
const includes = Object.values(config.outputFileTracingIncludes ?? {}).flat();

/** Каталог цели подпутевого импорта: './js/standard-fonts/*.cjs' → 'node_modules/pdfkit/js/standard-fonts'. */
function targetDir(target: string): string {
  return posix.join('node_modules/pdfkit', posix.dirname(target.replace(/^\.\//, '')));
}

describe('pdfkit: шрифты, загружаемые по подпутевому импорту, едут в standalone', () => {
  const fontImports = Object.entries(pkg.imports ?? {})
    .filter(([key]) => key.startsWith('#standard-fonts'))
    .map(([key, target]) => ({ key, target: String(target) }));

  it('сборка pdfkit для node действительно грузит шрифты через #standard-fonts (иначе сторож не про то)', () => {
    expect(nodeBuild).toContain("'#standard-fonts/Helvetica'");
    expect(fontImports.length).toBeGreaterThan(0);
  });

  it('каждый каталог цели включён в outputFileTracingIncludes', () => {
    for (const { key, target } of fontImports) {
      const dir = targetDir(target);
      expect(existsSync(join(ROOT, dir)), `${key}: каталога ${dir} нет в установленном pdfkit ${pkg.version}`).toBe(true);
      const covered = includes.some((g) => g.replace(/^\.\//, '').replace(/\/\*\*$/, '') === dir);
      expect(covered, `${key} → ${dir}: нет в outputFileTracingIncludes next.config.js — PDF упадёт на проде «Cannot find module»`).toBe(true);
    }
  });

  it('шрифт Helvetica (им пишут все наши PDF) и его общий модуль глифов на месте', () => {
    const helv = join(PDFKIT, 'js/standard-fonts/Helvetica.cjs');
    expect(existsSync(helv)).toBe(true);
    // Шрифт тянет соседний chunks/standardGlyphNames-*.cjs: он в том же каталоге, include его покрывает.
    const dep = /require\('(\.\/chunks\/[^']+)'\)/.exec(readFileSync(helv, 'utf8'))?.[1];
    expect(dep).toBeTruthy();
    expect(existsSync(join(dirname(helv), dep!))).toBe(true);
  });
});
