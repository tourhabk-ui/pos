/**
 * Разбор текста миграции для сторожей карточек мест: что ИСПОЛНИТСЯ, а не
 * как это записано. Комментарии отброшены, операторы разделены, значения
 * склеены из литералов `'…' || E'\n' || '…'` — так, как их сложит база.
 *
 * Вынесено из сторожа 1250, когда та же разборка понадобилась 1252: две
 * копии одного разбора расходятся молча, и сторож одной миграции начинает
 * судить иначе, чем сторож другой.
 */

/** Тело миграции без комментариев. */
export function migrationBody(sql: string): string {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
}

/** Операторы: конец — «;» в конце строки (в текстах «;» бывает и внутри). */
export function migrationStatements(body: string): string[] {
  return body.split(/;\s*\n/);
}

/** Делит список по запятым верхнего уровня — вне кавычек и скобок. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === "'") {
        if (s[i + 1] === "'") cur += s[++i];
        else quoted = false;
      }
      continue;
    }
    if (c === "'") quoted = true;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Значение выражения из литералов: `'…' || E'\n' || '…'`; NULL — null. */
export function valueOf(expr: string): string | null {
  if (/^NULL$/i.test(expr.trim())) return null;
  const parts = [...expr.matchAll(/E'\\n'|'((?:[^']|'')*)'/g)];
  if (parts.length === 0) return expr.trim();
  return parts.map((m) => (m[0] === "E'\\n'" ? '\n' : m[1].replace(/''/g, "'"))).join('');
}

/** INSERT … SELECT: колонка → значение по позиции. Число значений обязано совпасть. */
export function insertValues(stmt: string): Record<string, string | null> {
  const cols = stmt.split(/INSERT INTO \w+ \(/)[1].split(')')[0].split(',').map((c) => c.trim());
  const select = stmt.split(/\n\s*SELECT\s/)[1].split(/\n\s*WHERE\b/)[0];
  const vals = splitTop(select);
  if (vals.length !== cols.length) {
    throw new Error(`INSERT: колонок ${cols.length}, значений ${vals.length}`);
  }
  return Object.fromEntries(cols.map((c, i) => [c, valueOf(vals[i])]));
}

/** UPDATE … SET: колонка → значение. */
export function setValues(stmt: string): Record<string, string | null> {
  const set = stmt.split(/\bSET\b/)[1].split(/\n\s*(?:WHERE|FROM)\b/)[0];
  return Object.fromEntries(
    splitTop(set).map((pair) => {
      const [col, ...rest] = pair.split('=');
      return [col.trim(), valueOf(rest.join('='))];
    }),
  );
}
