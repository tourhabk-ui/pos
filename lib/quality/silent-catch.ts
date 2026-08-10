/**
 * lib/quality/silent-catch.ts
 *
 * Тихая поломка: `catch`, возвращающий форму, неотличимую от успеха.
 *
 * За один вечер 10.08 этот класс вскрылся пять раз подряд, в разных
 * подсистемах и с одинаковым исходом — отсутствие результата выглядело как
 * результат:
 *
 *   /api/public/danger-summary  — запрос падал на несуществующей колонке,
 *     catch отдавал `{zones: [], updatedAt: null}`, страница /safety при пустом
 *     списке объявляла «Обстановка нормальная». Зелёным. Из нуля данных.
 *   app/_home/data.ts           — catch возвращает `{activeCount: 0, alerts: [],
 *     volcanoes: []}`; главная в случае сбоя показывает спокойствие, и снаружи
 *     не отличить «угроз нет» от «запрос не выполнился».
 *   выкладка карты              — шаг пропускался всегда, прогон был зелёным.
 *   синк KVERT                  — падал 13 дней, liveness считал крон живым.
 *   ночной smoke                — краснел 6 ночей впустую, его перестали читать.
 *
 * Общее у всех: сбой принимает форму нормы. Такое не ловится ни типами, ни
 * тестами без БД, ни глазами при чтении диффа — зато ловится механически.
 *
 * ЧТО СЧИТАЕТСЯ НАРУШЕНИЕМ. `catch`, из которого возвращается объект, где ВСЕ
 * значения пустые (пустой массив, ноль, null, пустая строка, false), и при этом
 * ответ не помечен ошибкой — ни кодом 4xx/5xx, ни полем вроде `ok: false`,
 * `success: false`, `error`.
 *
 * ЧТО НАРУШЕНИЕМ НЕ СЧИТАЕТСЯ. Честная деградация, где пустота — осознанный
 * ответ, а сбой назван: `{ ok: false, zones: [] }`, `status: 503`,
 * `{ success: false, error }`. И проброс ошибки наверх (`throw`).
 *
 * Чистые функции: тестируются без БД и без сети.
 */

export interface SilentCatch {
  /** Строка, на которой открывается `catch`. */
  line: number;
  /** Возвращаемое выражение — попадёт в отчёт, чтобы находку можно было понять. */
  returned: string;
}

/** Значения, которые «ничего не значат»: из них состоит форма-пустышка. */
const EMPTY_VALUE = /^\s*(\[\s*\]|\{\s*\}|0|null|undefined|''|""|``|false|NaN)\s*$/;

/** Признаки того, что ответ ЧЕСТНО помечен как сбой. */
const HONEST_MARK = /\b(ok\s*:\s*false|success\s*:\s*false|error|status\s*:\s*[45]\d\d|degraded|stale|failed)\b/i;

/** Разбивает содержимое объекта на пары по запятым нулевой глубины. */
function splitProps(body: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', quote = '';
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Пустышка ли это — объект, все значения которого ничего не сообщают.
 *
 * Объект без единого свойства пустышкой НЕ считается: `{}` в catch чаще всего
 * означает «ответа нет», а не «всё хорошо, данных ноль».
 */
export function isEmptyShape(expr: string): boolean {
  const m = /^\s*\{([\s\S]*)\}\s*$/.exec(expr.trim());
  if (!m) return false;
  const props = splitProps(m[1]).filter((p) => p.trim());
  if (props.length === 0) return false;

  for (const p of props) {
    const i = p.indexOf(':');
    if (i < 0) return false; // сокращённая запись `{ rows }` — значение неизвестно
    if (!EMPTY_VALUE.test(p.slice(i + 1))) return false;
  }
  return true;
}

/** Тело `catch`, начиная с открывающей фигурной скобки. Null — не разобралось. */
function catchBody(src: string, braceIdx: number): string | null {
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceIdx + 1, i); }
  }
  return null;
}

/**
 * Находит в исходнике тихие catch-блоки (чистая).
 *
 * Разбор построчный и намеренно грубый: задача не разобрать TypeScript, а
 * отличить «сбой назван» от «сбой притворился нормой». Ошибиться в сторону
 * пропуска дешевле, чем в сторону ложного обвинения: гард, который ругается на
 * честный код, учат обходить.
 */
export function findSilentCatches(src: string): SilentCatch[] {
  const out: SilentCatch[] = [];
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const braceIdx = m.index + m[0].length - 1;
    const body = catchBody(src, braceIdx);
    if (body === null) continue;

    // Сбой назван где-то в теле — этого достаточно, разбирать дальше незачем.
    if (HONEST_MARK.test(body)) continue;

    // Возвраты вида `return { ... }` и `return NextResponse.json({ ... })`.
    const retRe = /return\s+(?:NextResponse\.json\s*\(\s*)?(\{[\s\S]*?\})\s*[);]/g;
    let r: RegExpExecArray | null;
    while ((r = retRe.exec(body)) !== null) {
      if (!isEmptyShape(r[1])) continue;
      const line = src.slice(0, braceIdx).split('\n').length;
      out.push({ line, returned: r[1].replace(/\s+/g, ' ').slice(0, 120) });
    }
  }
  return out;
}
