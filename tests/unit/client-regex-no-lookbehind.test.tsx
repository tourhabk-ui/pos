/**
 * В клиентском бандле нет lookbehind и флагов d, v в регулярках.
 *
 * ── Повод (#2527, ревью 22.10) ────────────────────────────────────────────
 *
 * Первая правка протоколов AI Спасателя провела границы слов lookbehind'ом,
 * как в серверном sos-detector. Но lib/safety/rescue-protocols едет в
 * браузер: RescueChat на /sos и /safety, хаб безопасности. Safari до 16.4
 * lookbehind не разбирает вовсе — регулярка падает SyntaxError при загрузке
 * модуля, а не при вызове, и вместе с модулем падает чанк экрана: /sos не
 * гидрируется, чат «AI Спасатель» не отвечает. Next собирает под Safari 12+
 * (browserslist по умолчанию), и SWC lookbehind не транспилирует — переписать
 * его нечем, кроме рук.
 *
 * Ревью 4-го круга: флаги d (hasIndices, Safari 15+) и v (unicodeSets,
 * Safari 17+) на том же пути дают ту же SyntaxError при загрузке модуля, а
 * сторож их не видел ни в литерале /…/v, ни в строке флагов new RegExp.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * 1. Запрет (регулярка по исходнику — ровно для запретов, §13.10): ни один
 *    модуль, до которого цепочкой импортов доходит файл с 'use client', не
 *    содержит lookbehind — ни литералом, ни строкой для new RegExp — и флагов
 *    d, v — ни у литерала, ни вторым аргументом new RegExp. Обход
 *    идёт вглубь, как в client-no-node-builtins: беда в цепочке, не в
 *    соседстве. Именованные группы (тот же префикс без «!» и «=») Safari
 *    понимает с 11.1 — их сторож не трогает.
 * 2. Связка: обход действительно доходит до rescue-protocols — иначе запрет
 *    зеленел бы, не видя модуль, ради которого заведён. Серверный
 *    sos-detector lookbehind держит законно; импорт его в клиент сторож
 *    покажет красным с цепочкой.
 * 3. Поведение: RescueChat рисуется в jsdom, и на «потерял паспорт» человек
 *    видит протокол утери, на «потерялись в лесу» — «заблудился». Модуль
 *    загрузился и все его регулярки скомпилировались на пути экрана.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import RescueChat from '@/components/safety/RescueChat';

const ROOT = process.cwd();

/** Lookbehind: «(?<!» и «(?<=». Собрано из частей, чтобы сторож не нашёл сам себя. */
const LOOKBEHIND = new RegExp('\\(\\?<' + '[!=]');

/**
 * Литерал регулярки после знака, за которым выражение (не деление), и его
 * флаги: «= /x/v», «(/x/dg», «return /x/v».
 */
const LITERAL_FLAGS = /(?:^|[=(,:[!&|?{;]|return)\s*\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/([dgimsuvy]*)(?![\w$])/g;
/** Строка флагов вторым аргументом new RegExp, в том числе через строки: «new RegExp(src, 'v')». */
const CTOR_FLAGS = /new RegExp\((?:(?!new RegExp)[\s\S]){0,2000}?,\s*(['"`])([dgimsuvy]*)\1\s*,?\s*\)/g;
/** Флаги, которых нет в Safari до 17: d — hasIndices (15+), v — unicodeSets (17+). */
const UNSUPPORTED_FLAG = /[dv]/;

/** Флаги d, v в исходнике: номер строки и сам флаг. */
function unsupportedFlags(src: string): string[] {
  const found: string[] = [];
  const at = (index: number) => src.slice(0, index).split('\n').length;
  for (const m of src.matchAll(LITERAL_FLAGS)) if (UNSUPPORTED_FLAG.test(m[1])) found.push(`${at(m.index ?? 0)}: /…/${m[1]}`);
  for (const m of src.matchAll(CTOR_FLAGS)) if (UNSUPPORTED_FLAG.test(m[2])) found.push(`${at(m.index ?? 0)}: new RegExp(…, '${m[2]}')`);
  return found;
}

/** Импорты внутри репозитория: статические, реэкспорт, побочные и import(). */
const LOCAL_IMPORT = /(?:from|import)\s*\(?\s*['"](@\/[^'"]+|\.\.?\/[^'"]+)['"]/g;
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

function resolveLocal(spec: string, fromAbs: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : resolve(dirname(fromAbs), spec);
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  for (const e of EXTS) if (existsSync(join(base, 'index' + e))) return join(base, 'index' + e);
  return null;
}

const rel = (abs: string) => abs.slice(ROOT.length + 1);

/** Все модули клиентского графа и цепочка, которой до каждого дошли. */
function clientGraph(): Map<string, string[]> {
  const files = execSync(
    `git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'components/**/*.ts' 'components/**/*.tsx' 'hooks/**/*.ts' 'hooks/**/*.tsx'`,
    { cwd: ROOT, encoding: 'utf-8' },
  ).trim().split('\n').filter(Boolean);

  const chain = new Map<string, string[]>();
  const stack: string[] = [];
  for (const f of files) {
    const abs = join(ROOT, f);
    // Директива стоит первой — иначе это не клиентский модуль.
    if (!/^\s*['"]use client['"]/.test(readFileSync(abs, 'utf-8'))) continue;
    chain.set(abs, [f]);
    stack.push(abs);
  }
  while (stack.length) {
    const abs = stack.pop() as string;
    const src = readFileSync(abs, 'utf-8');
    for (const m of src.matchAll(LOCAL_IMPORT)) {
      const next = resolveLocal(m[1], abs);
      if (!next || chain.has(next)) continue;
      chain.set(next, [...(chain.get(abs) ?? []), rel(next)]);
      stack.push(next);
    }
  }
  return chain;
}

const graph = clientGraph();

describe('клиентский бандл: регулярки без lookbehind', () => {
  it('граф импортов из клиента доходит до протоколов AI Спасателя', () => {
    const protocols = graph.get(join(ROOT, 'lib/safety/rescue-protocols.ts'));
    expect(protocols, 'обход не видит rescue-protocols — запрет ниже судил бы пустоту').toBeDefined();
    expect(protocols?.[0]).toMatch(/RescueChat|SafetyHubClient/);
  });

  it('ни один модуль, достижимый из \'use client\', не содержит lookbehind', () => {
    const offenders: string[] = [];
    for (const [abs, path] of graph) {
      const lines = readFileSync(abs, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (LOOKBEHIND.test(line)) offenders.push(`${path.join(' → ')}:${i + 1}`);
      });
    }
    expect(
      offenders,
      'lookbehind в клиентском коде: Safari < 16.4 падает SyntaxError на загрузке модуля. ' +
        'Левую границу слова — захватом префикса (?:^|[^а-яёa-z0-9])',
    ).toEqual([]);
  });

  it('ни один модуль, достижимый из \'use client\', не берёт флаги d и v', () => {
    const offenders: string[] = [];
    for (const [abs, path] of graph) {
      for (const hit of unsupportedFlags(readFileSync(abs, 'utf-8'))) offenders.push(`${path.join(' → ')}:${hit}`);
    }
    expect(offenders, 'флаг d — Safari 15+, v — Safari 17+: старый Safari падает SyntaxError на загрузке модуля').toEqual([]);
  });

  it('поиск флагов видит литерал и конструктор, а /x/i и деление не трогает', () => {
    expect(unsupportedFlags('const a = /x/v;')).toHaveLength(1);
    expect(unsupportedFlags('foo(/x/dg)')).toHaveLength(1);
    expect(unsupportedFlags("const r = new RegExp('x', 'v');")).toHaveLength(1);
    expect(unsupportedFlags('const r = new RegExp(\n  `${B}x`,\n  \'dv\',\n);')).toHaveLength(1);
    expect(unsupportedFlags("const a = /x/i; const b = new RegExp('x', 'i'); const c = n / d / v;")).toEqual([]);
    // Путь в комментарии — не литерал: «(/radar/devices)».
    expect(unsupportedFlags('// экран (/radar/devices)')).toEqual([]);
  });

  it('серверный sos-detector в клиентский граф не входит (у него lookbehind законно)', () => {
    const chain = graph.get(join(ROOT, 'lib/safety/sos-detector.ts'));
    expect(chain?.join(' → ')).toBeUndefined();
  });
});

describe('RescueChat в jsdom: модуль протоколов загружен и отвечает', () => {
  // В jsdom нет scrollIntoView, а чат прокручивает ленту к последнему ответу.
  const originalScroll = Element.prototype.scrollIntoView;
  beforeAll(() => { Element.prototype.scrollIntoView = function scrollIntoView() { /* jsdom: прокрутки нет */ }; });
  afterAll(() => { Element.prototype.scrollIntoView = originalScroll; });
  afterEach(cleanup);

  const ask = (text: string) => {
    fireEvent.change(screen.getByLabelText('Опишите ситуацию'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
  };

  it('«потерял паспорт» — протокол утери; «потерялись в лесу» — «заблудился»', () => {
    render(<RescueChat surface="sos" />);
    fireEvent.click(screen.getByRole('button', { name: /AI Спасатель/ }));

    ask('потерял паспорт');
    expect(screen.getByText(/талон-уведомление/)).toBeTruthy();
    expect(screen.queryByText(/3 свистка/)).toBeNull();

    ask('потерялись в лесу');
    expect(screen.getByText(/3 свистка подряд/)).toBeTruthy();
  });
});
