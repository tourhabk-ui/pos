/**
 * Сторож замера «написано и никем не зовётся».
 *
 * Замер, который врёт, хуже отсутствующего: его нельзя ни заморозить, ни
 * показать человеку. Поэтому здесь закреплены ровно те случаи, на которых
 * замер 21.08 соврал по дороге — дважды, и оба раза в одну сторону: объявлял
 * вызываемое невызываемым.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  isTestFile,
  exportedFunctions,
  importsOf,
  codeIdentifiers,
  selfUses,
  classifyExports,
  summarize,
  type ImportEdge,
} from '@/lib/quality/export-census';

const ROOT = process.cwd();

describe('exportedFunctions', () => {
  it('берёт объявления и стрелочные константы', () => {
    const src = [
      'export function a() {}',
      'export async function b() {}',
      'export const c = (x: number) => x;',
      'export const d = async (): Promise<void> => {};',
      'function notExported() {}',
      'export const e = 5;',
      'export interface F { x: number }',
    ].join('\n');
    expect(exportedFunctions(src).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('тип не считается механизмом', () => {
    expect(exportedFunctions('export type T = () => void;')).toEqual([]);
  });

  it('не считает объявление внутри шаблонной строки', () => {
    // Промпты агентов носят в себе образцы кода; механизмом платформы они не
    // становятся.
    const src = 'const prompt = `\nexport function looksLikeCode() {}\n`;\nexport function real() {}\n';
    expect(exportedFunctions(src)).toEqual(['real']);
  });
});

describe('importsOf', () => {
  it('именованный импорт, звёздочка, переэкспорт', () => {
    const src = [
      "import { a, b as c, type D } from './x';",
      "import * as ns from './y';",
      "export { e } from './z';",
      "export * from './w';",
    ].join('\n');
    const got = importsOf(src);
    expect(got).toContainEqual({ spec: './x', names: ['a', 'b'], reexport: false });
    expect(got).toContainEqual({ spec: './y', names: null, reexport: false });
    expect(got).toContainEqual({ spec: './z', names: ['e'], reexport: true });
    expect(got).toContainEqual({ spec: './w', names: null, reexport: true });
  });

  it('пример импорта в док-комментарии вызовом не является', () => {
    // На этом `withCsrfProtection` числился используемым: защита не подключена
    // ни к одному роуту, но её образец лежит в шапке собственного файла.
    const src = [
      '/**',
      " * import { withCsrfProtection } from '@/lib/middleware/csrf';",
      ' */',
      "import { real } from './x';",
      'void real;',
    ].join('\n');
    expect(importsOf(src)).toEqual([{ spec: './x', names: ['real'], reexport: false }]);
  });

  it('import type ничего не зовёт', () => {
    expect(importsOf("import type { Foo } from './x';")).toEqual([]);
    expect(importsOf("import { type Foo, bar } from './x';")).toEqual([
      { spec: './x', names: ['bar'], reexport: false },
    ]);
  });

  it('ленивая загрузка — тоже вызов', () => {
    const got = importsOf("const { callGeminiTranscribe } = await import('@/lib/ai/providers');");
    expect(got).toContainEqual({ spec: '@/lib/ai/providers', names: ['callGeminiTranscribe'], reexport: false });
    // и не продублирован как «весь модуль» — иначе весь providers.ts стал бы «used»
    expect(got.filter((e) => e.names === null)).toEqual([]);
  });

  it('динамический импорт без разбора имён берёт модуль целиком', () => {
    expect(importsOf("await import('./side-effect');")).toEqual([
      { spec: './side-effect', names: null, reexport: false },
    ]);
  });
});

describe('codeIdentifiers — разбор, а не угадывание', () => {
  it('не считает имя, упомянутое в комментарии', () => {
    const src = 'export function callMiMo() {}\n// Функция callMiMo оставлена на будущее.\n';
    expect(codeIdentifiers(src).get('callMiMo')).toBe(1);
    expect(selfUses(src, 'callMiMo')).toBe(false);
  });

  it('не считает имя внутри строки', () => {
    const src = "export function foo() {}\nconst names = ['foo', 'bar'];\n";
    expect(selfUses(src, 'foo')).toBe(false);
  });

  it('не сбивается на литерале с кавычкой и на регулярке', () => {
    // На этом рассыпалось вырезание строк регуляркой: апостроф внутри строки
    // и слэши регулярки рассинхронизировали разбор, и остаток файла уходил
    // «в строку» — вместе с настоящими вызовами.
    const src = [
      "export function target() {}",
      "const s = 'it\\'s fine';",
      "const re = /['\"]/g;",
      "const url = 'https://example.com/x';",
      "target();",
    ].join('\n');
    expect(selfUses(src, 'target')).toBe(true);
  });

  it('не обрывается на шаблонной строке с подстановкой', () => {
    // Голый сканер токенов здесь останавливался, насчитав 261 имя на файле в
    // 2700 строк, и объявлял вызываемое невызываемым.
    const src = [
      'export function target() {}',
      'const a = 1;',
      'const t = `значение ${a} и ${`вложенный ${a}`}`;',
      'target();',
    ].join('\n');
    expect(selfUses(src, 'target')).toBe(true);
  });

  it('регрессия на живом файле: providers.ts зовёт свои resolveDecisionModel и callGLM', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/ai/providers.ts'), 'utf8');
    expect(selfUses(src, 'resolveDecisionModel')).toBe(true);
    expect(selfUses(src, 'callGLM')).toBe(true);
  });
});

describe('classifyExports — пять исходов', () => {
  const declared = new Map([['lib/m.ts', ['used', 'byTest', 'lonely', 'inner']]]);

  const edges: ImportEdge[] = [
    { from: 'app/api/x/route.ts', to: 'lib/m.ts', names: ['used'], reexport: false },
    { from: 'tests/unit/m.test.ts', to: 'lib/m.ts', names: ['byTest'], reexport: false },
  ];
  const sources = new Map([
    ['lib/m.ts', 'export function used(){}\nexport function byTest(){}\nexport function lonely(){}\nexport function inner(){}\nused();\ninner();\n'],
  ]);

  it('рабочий код зовёт — used', () => {
    const r = classifyExports(declared, edges, sources);
    expect(r.find((x) => x.name === 'used')?.state).toBe('used');
  });

  it('снаружи только тест, свой файл не зовёт — test-only', () => {
    const r = classifyExports(declared, edges, sources);
    expect(r.find((x) => x.name === 'byTest')?.state).toBe('test-only');
  });

  it('не зовёт никто — orphan', () => {
    const r = classifyExports(declared, edges, sources);
    expect(r.find((x) => x.name === 'lonely')?.state).toBe('orphan');
  });

  it('зовёт свой файл — internal, а не сирота', () => {
    const r = classifyExports(declared, edges, sources);
    expect(r.find((x) => x.name === 'inner')?.state).toBe('internal');
  });

  it('без исходников состояние internal не выдумывается', () => {
    const r = classifyExports(declared, edges);
    expect(r.find((x) => x.name === 'inner')?.state).toBe('orphan');
  });

  it('`import * as` считает весь модуль использованным', () => {
    const r = classifyExports(declared, [
      { from: 'app/p.ts', to: 'lib/m.ts', names: null, reexport: false },
    ]);
    expect(r.every((x) => x.state === 'used')).toBe(true);
  });

  it('переэкспорт разрешается транзитивно по конечному потребителю', () => {
    const d = new Map([['lib/deep.ts', ['f']]]);
    const chain: ImportEdge[] = [
      { from: 'lib/index.ts', to: 'lib/deep.ts', names: ['f'], reexport: true },
      { from: 'app/p.ts', to: 'lib/index.ts', names: ['f'], reexport: false },
    ];
    expect(classifyExports(d, chain)[0].state).toBe('used');
  });

  it('бочка, которую дальше никто не берёт, — barrel, а не used', () => {
    const d = new Map([['lib/deep.ts', ['f']]]);
    const chain: ImportEdge[] = [
      { from: 'lib/index.ts', to: 'lib/deep.ts', names: ['f'], reexport: true },
    ];
    expect(classifyExports(d, chain)[0].state).toBe('barrel');
  });

  it('круговой переэкспорт не зацикливает и не считается использованием', () => {
    const d = new Map([['lib/a.ts', ['f']]]);
    const cycle: ImportEdge[] = [
      { from: 'lib/b.ts', to: 'lib/a.ts', names: ['f'], reexport: true },
      { from: 'lib/a.ts', to: 'lib/b.ts', names: ['f'], reexport: true },
    ];
    expect(classifyExports(d, cycle)[0].state).not.toBe('used');
  });
});

describe('summarize', () => {
  it('состояния не сливаются в одну сумму', () => {
    const s = summarize([
      { file: 'a', name: '1', state: 'used' },
      { file: 'a', name: '2', state: 'internal' },
      { file: 'a', name: '3', state: 'test-only' },
      { file: 'a', name: '4', state: 'barrel' },
      { file: 'a', name: '5', state: 'orphan' },
    ]);
    expect(s).toEqual({ total: 5, used: 1, internal: 1, testOnly: 1, barrel: 1, orphan: 1 });
  });
});

describe('isTestFile', () => {
  it('по расположению и по суффиксу', () => {
    expect(isTestFile('tests/unit/x.test.ts')).toBe(true);
    expect(isTestFile('lib/__tests__/x.ts')).toBe(true);
    expect(isTestFile('lib/x.spec.tsx')).toBe(true);
    expect(isTestFile('lib/x.ts')).toBe(false);
    // «latest» не начинается с tests/ — подстрока не должна срабатывать
    expect(isTestFile('lib/protests/x.ts')).toBe(false);
  });
});
