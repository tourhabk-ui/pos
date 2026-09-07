/**
 * lib/ai/json-salvage.ts — целые объекты из ОБОРВАННОГО ответа модели.
 *
 * Ответ, обрезанный на потолке токенов, не разбирается целиком: закрывающей
 * скобки у него нет. Но написанные до обрыва объекты — настоящие, и терять их
 * значит выбрасывать работу модели вместе с её обрывом.
 *
 * Заведено 05.09 внутри изобретателя, вынесено 06.09: тем же вечером линза
 * «ИИ-фичи» получила от Opus 5 оборванный массив и записала его как «массива
 * JSON в ответе нет» — притом что ответ НАЧИНАЛСЯ с `[{"title":...`. Правило
 * было, дома у него не было, и второй потребитель до него не дотянулся.
 */

/**
 * Целые объекты из оборванного JSON-массива. Идёт по объектам верхнего
 * уровня, считая скобки вне строк; последний недописанный отбрасывается.
 * Чистая функция, без сети.
 */
export function salvageTruncatedArray(raw: string): unknown[] {
  const text = raw.trim();
  if (!text.startsWith('[')) return [];
  const out: unknown[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let objStart = -1;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(text.slice(objStart, i + 1)) as unknown;
          if (obj && typeof obj === 'object') out.push(obj);
        } catch {
          // недописанный или битый элемент — не спасаем
        }
        objStart = -1;
      }
    }
  }
  return out;
}
