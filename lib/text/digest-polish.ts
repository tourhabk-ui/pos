/**
 * Последняя правка текста выпуска перед отправкой — детерминированно, без
 * модели (CLAUDE.md §8: гард, а не абзац в промпте).
 *
 * Ставится ПОСЛЕ фактчека: судья сверяет числа с источником, а в источнике они
 * записаны по-английски. Поменять запись раньше — значит заставить судью
 * искать «1 702 790» там, где стоит «1,702,790».
 *
 * ── Числа (пост 24.09) ─────────────────────────────────────────────────────
 *
 * «2,000+ голосов», «3,656 моделей», «1,702,790 из 1,702,797 граней». Промпт
 * велит брать цифры дословно, и модель честно переносит английскую запись
 * разрядов. По-русски разряды отделяются пробелом, а запятая — десятичный
 * знак: «3,656» читается как «три целых шестьсот пятьдесят шесть тысячных».
 * Четырёхзначные пишутся слитно (3656), от пяти знаков — с пробелами.
 *
 * ── Оборванный хвост (дайджест 24.09) ──────────────────────────────────────
 *
 * «Корпорация развития Камчатки представила кита» — и всё. Размышление модели
 * растягивается под бюджет токенов (шапка callAIQuality в lib/ai/providers.ts),
 * и ответ обрывается около 2,4-2,5 тыс. знаков; наверх обрыв не сообщается.
 * Последняя строка без конца фразы — признак обрыва: она отрезается, вместе с
 * опустевшим заголовком раздела и незакрытым тегом. Отрезанное возвращается
 * вызывающему — он обязан назвать его в отчёте, а не проглотить (§4.0).
 */

import { stripTags } from '@/lib/html/text';

/** Неразрывный пробел: разряд не переносится на новую строку. */
const NBSP = '\u00A0';

/** Английская запись разрядов → русская, только вне тегов. */
export function ruThousands(html: string): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part : part.replace(
      // Ведущая цифра 1-9: «0,125» — десятичная дробь, а не тысячи.
      /(?<![\d.,])([1-9]\d{0,2}(?:,\d{3})+)(?![\d,]|\.\d)/g,
      (m) => {
        const digits = m.replace(/,/g, '');
        if (digits.length <= 4) return digits;
        return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
      },
    )))
    .join('');
}

const TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler']);

/** Строка закончена: знак конца фразы, закрывающая ссылка или цитата. */
function lineIsFinished(line: string): boolean {
  const raw = line.trim();
  if (/<\/(a|blockquote)>$/i.test(raw)) return true;
  const text = stripTags(raw).trim();
  return /[.!?…»")\]]$/.test(text);
}

/** Строка — голый заголовок раздела: «<b>Камчатка</b>». */
function isBareHeader(line: string): boolean {
  return /^<b>[^<]*<\/b>$/i.test(line.trim());
}

/** Позиция последнего незакрытого тега или -1. */
function lastUnclosedTag(html: string): number {
  const stack: Array<{ name: string; at: number }> = [];
  const rx = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null) {
    const name = m[2].toLowerCase();
    if (!TAGS.has(name)) continue;
    if (!m[1]) { stack.push({ name, at: m.index }); continue; }
    const idx = stack.map((s) => s.name).lastIndexOf(name);
    if (idx !== -1) stack.splice(idx);
  }
  return stack.length > 0 ? stack[0].at : -1;
}

/**
 * Отрезает оборванный хвост. Возвращает текст и отрезанные строки (пусто —
 * обрыва не было). Обрывом считается только ПОСЛЕДНЯЯ строка: середину текста
 * модель не обрывает.
 */
export function trimUnfinishedTail(html: string): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  let text = html.trimEnd();

  // Незакрытый тег — верный признак обрыва: всё от него отрезается.
  const open = lastUnclosedTag(text);
  if (open !== -1) {
    dropped.push(text.slice(open).trim());
    text = text.slice(0, open).trimEnd();
  }

  const lines = text.split('\n');
  const last = () => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i;
    return -1;
  };
  let i = last();
  // Строка без точки — обрыв, только если остальной текст точки ставит: пункт
  // «Product Hunt: minimi 2.0» законно кончается цифрой, и модель, которая
  // в этом выпуске пишет без точек, не должна терять последний пункт.
  const content = lines.filter((l, k) => k !== i && l.trim() && !isBareHeader(l));
  const finishedShare = content.length > 0 ? content.filter(lineIsFinished).length / content.length : 0;
  const writesPunctuation = content.length >= 2 && finishedShare >= 0.8;
  if (i !== -1 && writesPunctuation && !isBareHeader(lines[i]) && !lineIsFinished(lines[i])) {
    dropped.push(lines[i].trim());
    lines.splice(i);
    i = last();
  }
  // Раздел, оставшийся без пунктов, — заголовок без содержания.
  if (dropped.length > 0 && i !== -1 && isBareHeader(lines[i])) {
    dropped.push(lines[i].trim());
    lines.splice(i);
  }
  return { text: lines.join('\n').trimEnd(), dropped };
}

/** Полная правка выпуска: хвост, потом числа. */
export function polishDigest(html: string): { text: string; dropped: string[] } {
  const { text, dropped } = trimUnfinishedTail(html);
  return { text: ruThousands(text), dropped };
}
