/**
 * lib/quality/export-census.ts — механизмы, которые написаны и никем не зовутся.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * Дважды за два месяца платформа платила днями за одно и то же: код был
 * написан, документирован — и не имел ни одного потребителя.
 *
 *   июль  — `validateRoutePost`: полный валидатор постов с комментарием
 *           «каждый пост ОБЯЗАН пройти валидацию», ни одного вызова. Канал
 *           опубликовал пост со ссылкой на мёртвую страницу.
 *   август — `checkOpenRouterBalance`: спрашивает счёт числом. Четверо суток
 *           причину немоты разбора читали из ТЕЛА чужой ошибки.
 *
 * Такой код неотличим от отсутствующего: о нём ничто не напоминает, и
 * «вспомнить все механизмы» нельзя — их сотни. Значит нужен не человек с
 * хорошей памятью, а замер.
 *
 * ── Четыре состояния, а не два ────────────────────────────────────────────
 *
 * Грубый поиск имени по файлам делит мир надвое и врёт в обе стороны. Здесь
 * разбираются настоящие импорты, и исходов четыре:
 *
 *   used      — зовут из рабочего кода. Всё в порядке.
 *   internal  — снаружи берут только тесты (или никто), но СВОЙ файл зовёт.
 *               Механизм работает, в прод попадает через соседний вход;
 *               лишний здесь только `export`. Не беда, а шум.
 *   test-only — зовут ТОЛЬКО тесты, и свой файл тоже не зовёт. Самое опасное
 *               состояние: код выглядит живым (есть сторож, есть зелёный
 *               прогон), но в проде его нет ни в одной ветке.
 *   barrel    — только переэкспорт через bare-файл, дальше никто не берёт.
 *   orphan    — не зовёт никто и нигде, включая свой файл.
 *
 * `internal` отделён после замера 21.08: без него `test-only` насчитывал 296
 * имён, и первая же проверка показала ложь — `computePrecision` числился
 * «только в тестах», хотя зовётся на 148-й строке собственного файла. Тогда
 * список нельзя ни заморозить, ни показать человеку: он состоит в основном из
 * шума, и настоящие двое утонут среди трёх сотен.
 *
 * `test-only` и `orphan` — РАЗНЫЕ беды и чинятся по-разному, поэтому не
 * сливаются в одну кучу (CLAUDE.md §4.0).
 *
 * ── Чего замер НЕ делает ──────────────────────────────────────────────────
 *
 * Не удаляет и не предлагает удалять. Сирота может быть намеренной: публичная
 * поверхность модуля, вызов по имени из конфигурации. Решение — за человеком;
 * задача замера в том, чтобы список существовал и не рос молча.
 */

import ts from 'typescript';

export type ExportState = 'used' | 'internal' | 'test-only' | 'barrel' | 'orphan';

export interface ExportRecord {
  /** Файл, где символ объявлен. */
  file: string;
  name: string;
  state: ExportState;
}

/** Импорт: откуда и какие имена. */
export interface ImportEdge {
  /** Файл-потребитель. */
  from: string;
  /** Файл-источник (уже разрешённый путь). */
  to: string;
  /**
   * Имена. `null` означает «весь модуль» (`import * as ns`) — тогда все
   * экспорты источника считаются использованными: доказать обратное нельзя,
   * а объявить живое мёртвым дороже, чем пропустить сироту.
   */
  names: string[] | null;
  /** Импорт ради переэкспорта (`export { x } from` / `export * from`). */
  reexport: boolean;
}

const TEST_RE = /(^|\/)(tests?|__tests__)\//;

/** Файл теста? Только по расположению и суффиксу, без догадок по содержимому. */
export function isTestFile(path: string): boolean {
  return TEST_RE.test(path) || /\.(test|spec)\.tsx?$/.test(path);
}

/**
 * Экспортируемые функции файла.
 *
 * Берутся объявления функций и стрелочные константы — то, что в разговоре
 * называют «механизмом». Типы и интерфейсы не считаются: неиспользуемый тип
 * ничего не обещает и никого не подводит.
 */
export function exportedFunctions(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) out.add(m[1]);
  // `export const f = (…) => …` и `export const f = async (…) => …`
  for (const m of src.matchAll(/^export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/gm)) out.add(m[1]);
  return [...out];
}

/**
 * Импорты и переэкспорты файла — с сырыми (неразрешёнными) путями.
 *
 * Алиас `@/` и относительные пути разрешает вызывающий: он один знает корень
 * репозитория и расширения файлов.
 */
export function importsOf(src: string): Array<{ spec: string; names: string[] | null; reexport: boolean }> {
  const out: Array<{ spec: string; names: string[] | null; reexport: boolean }> = [];

  // import { a, b as c } from 'x'   /   import Def, { a } from 'x'
  for (const m of src.matchAll(/import\s+(?:[\w*\s,]+?)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[2], names: splitNames(m[1]), reexport: false });
  }
  // import * as ns from 'x'  → весь модуль
  for (const m of src.matchAll(/import\s+\*\s+as\s+\w+\s+from\s*['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[1], names: null, reexport: false });
  }
  // export { a } from 'x'
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[2], names: splitNames(m[1]), reexport: true });
  }
  // export * from 'x'
  for (const m of src.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[1], names: null, reexport: true });
  }
  // const { a } = await import('x')  — ленивая загрузка тоже вызов
  for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[2], names: splitNames(m[1]), reexport: false });
  }
  // await import('x') без разбора имён / import('x').then(...) → весь модуль
  for (const m of src.matchAll(/(?<!\}\s*=\s*await\s)\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ spec: m[1], names: null, reexport: false });
  }
  return out;
}

/** `a, b as c, type D` → ['a','b'] (переименование берёт ИСХОДНОЕ имя). */
function splitNames(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith('type '))
    .map((p) => p.split(/\s+as\s+/)[0].trim())
    .filter((p) => /^\w+$/.test(p));
}


/**
 * Идентификаторы файла — только те, что стоят в КОДЕ.
 *
 * Считает сканер TypeScript, а не регулярка. Регулярка здесь уже соврала:
 * замер 21.08 объявил `resolveDecisionModel` и `callGLM` вызываемыми только
 * из тестов, хотя оба зовутся в своём файле. Вырезание строк регуляркой
 * рассинхронизировалось на литерале с кавычкой внутри и съело куски кода —
 * а замер, который врёт, хуже отсутствующего: его нельзя ни заморозить, ни
 * показать человеку.
 */
export function codeIdentifiers(src: string, path = 'x.ts'): Map<string, number> {
  const counts = new Map<string, number>();
  // Разбор, а не сканирование токенов: голый сканер не знает, где кончается
  // шаблонная строка с `${}` и где `/` начинает регулярку — на providers.ts
  // он молча обрывался, насчитав 261 имя вместо тысяч, и снова объявлял
  // вызываемое невызываемым.
  // Вид разбора берётся из расширения: в TSX `<T>(x) => x` — это тег, а не
  // дженерик, и наоборот.
  const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, /* setParentNodes */ false, kind);
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    node.forEachChild(walk);
  };
  file.forEachChild(walk);
  return counts;
}

/**
 * Зовёт ли файл свой собственный экспорт?
 *
 * Одно вхождение — само объявление; всё сверх него означает, что механизм
 * достижим изнутри файла и в прод попадает через соседний вход.
 */
export function selfUses(src: string, name: string, path = 'x.ts'): boolean {
  return (codeIdentifiers(src, path).get(name) ?? 0) > 1;
}

export function classifyExports(
  declared: Map<string, string[]>,
  edges: ImportEdge[],
  sources?: Map<string, string>,
): ExportRecord[] {
  // file → кто и как его импортирует
  const incoming = new Map<string, ImportEdge[]>();
  for (const e of edges) {
    const list = incoming.get(e.to) ?? [];
    list.push(e);
    incoming.set(e.to, list);
  }

  const records: ExportRecord[] = [];
  for (const [file, names] of declared) {
    const src = sources?.get(file);
    // Сканер запускается один раз на файл, а не на каждое имя.
    const ids = src === undefined ? null : codeIdentifiers(src, file);
    for (const name of names) {
      let state = stateOf(file, name, incoming, new Set());
      // Снаружи не зовут — но, может, зовёт свой файл. Тогда это не мёртвый
      // механизм, а лишнее слово `export`.
      if (state !== 'used' && ids !== null && (ids.get(name) ?? 0) > 1) state = 'internal';
      records.push({ file, name, state });
    }
  }
  return records;
}

function stateOf(
  file: string,
  name: string,
  incoming: Map<string, ImportEdge[]>,
  seen: Set<string>,
): ExportState {
  const key = `${file}#${name}`;
  // Круговой переэкспорт не должен зацикливать разбор и не считается
  // использованием: бочка, ссылающаяся на бочку, никого не зовёт.
  if (seen.has(key)) return 'orphan';
  seen.add(key);

  const edges = (incoming.get(file) ?? []).filter((e) => e.names === null || e.names.includes(name));
  if (edges.length === 0) return 'orphan';

  let sawBarrel = false;
  let sawTest = false;

  for (const e of edges) {
    if (e.reexport) {
      // Пошли дальше по цепочке: важен конечный потребитель, а не бочка.
      const downstream = stateOf(e.from, name, incoming, seen);
      if (downstream === 'used') return 'used';
      if (downstream === 'test-only') sawTest = true;
      sawBarrel = true;
      continue;
    }
    if (isTestFile(e.from)) { sawTest = true; continue; }
    return 'used';
  }

  if (sawTest) return 'test-only';
  return sawBarrel ? 'barrel' : 'orphan';
}

export interface CensusSummary {
  total: number;
  used: number;
  internal: number;
  testOnly: number;
  barrel: number;
  orphan: number;
}

/** Свод. Числа отдельно по состояниям — одна сумма скрыла бы разницу бед. */
export function summarize(records: ExportRecord[]): CensusSummary {
  return {
    total: records.length,
    used: records.filter((r) => r.state === 'used').length,
    internal: records.filter((r) => r.state === 'internal').length,
    testOnly: records.filter((r) => r.state === 'test-only').length,
    barrel: records.filter((r) => r.state === 'barrel').length,
    orphan: records.filter((r) => r.state === 'orphan').length,
  };
}
