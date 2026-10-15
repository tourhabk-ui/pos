/**
 * lib/quality/empty-catch.ts
 *
 * Пустой catch: отказ пойман и не назван никак (CLAUDE.md §4.0 — «пустой
 * `catch` превращает поломку в „данных нет“; ловить можно, молчать нельзя»).
 *
 * Соседний сторож `silent-catch` ловит одну форму из трёх — catch, который
 * ВОЗВРАЩАЕТ пустышку, похожую на успех. Аудит 15.10 (P4-03) насчитал рядом
 * сотни catch без единого оператора и `.catch(() => {})`, которых не держал
 * никто: так отказ всего AI-конвейера лида выглядел как «лид создан».
 *
 * Здесь две формы, и обе — молчание в чистом виде:
 *
 *   block    — `catch { }` / `catch (e) { /* комментарий *\/ }`: в теле нет ни
 *              одного оператора. Комментарий оператором не считается — он
 *              объясняет молчание читателю кода, но не логу.
 *   promise  — `.catch(() => {})` / `.catch(function () {})`: обработчик
 *              отказа с пустым телом.
 *
 * Чего здесь НЕТ намеренно: `.catch(() => null)`, `=> undefined`, `=> ''`.
 * Часто это честное «значения нет» — `res.json().catch(() => null)` при
 * разборе тела, где вызывающий дальше проверяет null. Отличить его от
 * проглоченного отказа по синтаксису нельзя, а сторож, который обвиняет
 * честный код, учат обходить (урок silent-catch 10.08).
 *
 * Разбор — парсером TypeScript, а не регуляркой: строка «catch {}» внутри
 * шаблонной строки, регулярного выражения или комментария не должна
 * считаться, а вложенные скобки регулярка не считает.
 *
 * Только для сторожей и переписей: в рабочий код не импортировать — парсер
 * TypeScript весит больше, чем весь образ может себе позволить (§6.1).
 */

import ts from 'typescript';

export type EmptyCatchForm = 'block' | 'promise';

export interface EmptyCatch {
  /** Строка (с единицы), на которой стоит `catch`. */
  line: number;
  form: EmptyCatchForm;
}

function scriptKind(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** Обработчик отказа без единого оператора в теле. */
function isEmptyHandler(node: ts.Expression): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  return ts.isBlock(node.body) && node.body.statements.length === 0;
}

/**
 * Находит пустые catch в исходнике (чистая: без файловой системы).
 * `fileName` нужен только чтобы отличить TSX от TS.
 */
export function findEmptyCatches(src: string, fileName = 'file.ts'): EmptyCatch[] {
  const file = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, scriptKind(fileName));
  const out: EmptyCatch[] = [];
  const lineOf = (pos: number) => file.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      out.push({ line: lineOf(node.getStart(file)), form: 'block' });
    } else if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'catch'
      && node.arguments.length > 0
      && isEmptyHandler(node.arguments[0])
    ) {
      out.push({ line: lineOf(node.expression.name.getStart(file)), form: 'promise' });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}
