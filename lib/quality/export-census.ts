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
 *
 * Разбором, а не регуляркой: строка `export function …` встречается и внутри
 * шаблонных строк (образцы кода в промптах агентов), и объявлять их
 * механизмами платформы неверно.
 */
export function exportedFunctions(src: string, path = 'x.ts'): string[] {
  const out = new Set<string>();
  const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, /* setParentNodes */ false, kind);

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const node of file.statements) {
    if (ts.isFunctionDeclaration(node) && isExported(node) && node.name !== undefined) {
      out.add(node.name.text);
      continue;
    }
    if (!ts.isVariableStatement(node) || !isExported(node)) continue;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.add(decl.name.text);
    }
  }
  return [...out];
}

/**
 * Импорты и переэкспорты файла — с сырыми (неразрешёнными) путями.
 *
 * Тоже разбором, а не регуляркой, и по той же причине: регулярка не отличает
 * КОД от ПРИМЕРА В ШАПКЕ. `lib/middleware/csrf.ts` носит в док-комментарии
 * образец «import { withCsrfProtection } from '@/lib/middleware/csrf'» — и
 * этого хватало, чтобы защита, не подключённая ни к одному роуту, числилась
 * используемой. Замер обязан считать вызовы, а не намерения.
 *
 * Алиас `@/` и относительные пути разрешает вызывающий: он один знает корень
 * репозитория и расширения файлов.
 */
export function importsOf(src: string, path = 'x.ts'): Array<{ spec: string; names: string[] | null; reexport: boolean }> {
  const out: Array<{ spec: string; names: string[] | null; reexport: boolean }> = [];
  const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, /* setParentNodes */ true, kind);

  const specText = (node: ts.Expression | undefined): string | null =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;

  // Переименование берёт ИСХОДНОЕ имя: `a as b` — это вызов `a`.
  const namedList = (el: ts.NamedImports | ts.NamedExports): string[] =>
    el.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);

  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = specText(node.moduleSpecifier);
      // `import type {...}` — тип ничего не зовёт.
      if (spec !== null && node.importClause?.isTypeOnly !== true) {
        const bindings = node.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          out.push({ spec, names: null, reexport: false });
        } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
          out.push({ spec, names: namedList(bindings), reexport: false });
        }
        // Импорт по умолчанию и импорт ради побочного эффекта не называют ни
        // одного нашего экспорта — ребра не даём.
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const spec = specText(node.moduleSpecifier);
      if (spec !== null && !node.isTypeOnly) {
        if (node.exportClause === undefined) out.push({ spec, names: null, reexport: true });
        else if (ts.isNamedExports(node.exportClause)) out.push({ spec, names: namedList(node.exportClause), reexport: true });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = specText(node.arguments[0]);
      if (spec !== null) out.push({ spec, names: destructuredNames(node), reexport: false });
    }
    node.forEachChild(walk);
  };
  file.forEachChild(walk);
  return out;
}

/**
 * Имена, разобранные из `const { a, b } = await import('x')`.
 *
 * `null` — модуль взят целиком: доказать, что конкретный экспорт не нужен,
 * нельзя, а объявить живое мёртвым дороже, чем пропустить сироту.
 */
function destructuredNames(call: ts.CallExpression): string[] | null {
  let node: ts.Node = call;
  if (node.parent !== undefined && ts.isAwaitExpression(node.parent)) node = node.parent;
  const decl = node.parent;
  if (decl === undefined || !ts.isVariableDeclaration(decl) || !ts.isObjectBindingPattern(decl.name)) return null;
  const names: string[] = [];
  for (const el of decl.name.elements) {
    const key = el.propertyName ?? el.name;
    if (!ts.isIdentifier(key)) return null; // вычисляемое имя — модуль взят целиком
    names.push(key.text);
  }
  return names;
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
