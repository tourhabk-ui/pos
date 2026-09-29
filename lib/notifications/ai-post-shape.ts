/**
 * Форма AI-поста: из чего он состоит и дотягивает ли до выпуска (26.09).
 *
 * Владелец 26.09 о посте в AI-канал на 6,8 тыс. подписчиков: «такой пост и
 * само оформление — полный кринж». В посте был один материал, оборванный на
 * полуслове, а под ним — кнопки с английскими заголовками чужих лент, и одна
 * из них («Aikido Security Releases Altar-1…») вела на материал, которого в
 * посте нет вовсе: кнопки строились из первых трёх сигналов ленты, а не из
 * того, что вошло в пост.
 *
 * Отсюда три правила, все детерминированные (§8: гард, а не абзац в промпте):
 *
 *  - материал — это блок поста с заголовком, выводом «Почему важно» и ссылкой
 *    на источник. Блок без любого из трёх — не материал, а обрывок или вода;
 *  - выпуск — это минимум два материала. Один материал — не дайджест, а
 *    случайная новость под шапкой «дайджест»; такой день канал пропускает;
 *  - кнопки — только на материалы поста, подписанные его же русским
 *    заголовком. С 27.09 кнопок нет вовсе: в вёрстке «Журнал» ссылкой
 *    служит сам заголовок материала (toJournalLayout).
 */

import { stripTags } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

export interface AiMaterial {
  title: string;
  url: string;
}

/** Минимум материалов в выпуске. */
export const AI_POST_MIN_MATERIALS = 2;

/**
 * Вывод «Почему важно» в начале строки или цитаты — с выделением или без.
 *
 * 28.09 (вечерний выпуск) пост не вышел с «0 полных материалов». Шаблон
 * 27.09 ставит вывод внутрь цитаты — `<blockquote><b>Почему важно:</b> …`, —
 * а модели свойственно опускать внутренний `<b>`: цитата и так выделена.
 * Счётчик узнавал вывод только по `<b>Почему важно`, и пост с двумя
 * полными материалами читался пустым. Узнаётся смысл строки, а не её жирность.
 */
const WHY_RX = /(?:^|\n|<blockquote[^>]*>)[ \t]*(?:<(?:b|strong|i|em)>[ \t]*)?Почему важно/i;

/** Выделенные фрагменты блока: <b> и <strong> — одно и то же для Telegram. */
function boldParts(block: string): RegExpMatchArray[] {
  return [...block.matchAll(/<(b|strong)>([\s\S]*?)<\/\1>/g)];
}

/**
 * Материалы поста по порядку. Блоки разделены пустой строкой; шапка
 * «AI-дайджест · …» и необязательная цитата-хвост материалами не считаются.
 */
export function aiPostMaterials(html: string): AiMaterial[] {
  const out: AiMaterial[] = [];
  for (const block of html.split(/\n\s*\n/)) {
    const titles = boldParts(block)
      .map((m) => stripTags(m[2]).trim())
      .filter((t) => t && !/^AI-дайджест/i.test(t) && !/^Почему важно/i.test(t));
    const title = titles[0];
    const why = WHY_RX.test(block);
    const href = block.match(/<a\s+href="([^"]+)"/i)?.[1];
    if (title && why && href) out.push({ title, url: decodeHtmlEntities(href) });
  }
  return out;
}

/**
 * Вёрстка «Журнал» (решение владельца 27.09, выбор из трёх вариантов).
 *
 * Заголовок материала — сам ссылка на статью, вывод «Почему важно» — плашкой
 * цитаты, строк «Читать →» нет. Кнопок под постом тоже нет: они повторяли бы
 * заголовки, которые и так ведут на статью.
 *
 * Шаблон в промпте — просьба, а вид канала не должен зависеть от того,
 * послушалась ли модель (§8: гард, а не абзац). Поэтому вёрстка приводится
 * здесь, детерминированно, из любого из двух видов ответа — старого
 * («Читать →» отдельной строкой) и нового. Смысл, факты и ссылки не
 * меняются: переставляется только разметка, и счёт материалов
 * (aiPostMaterials) до и после одинаков.
 */
export function toJournalLayout(html: string): string {
  return html.split(/(\n\s*\n)/).map((block) => {
    if (/^\s*$/.test(block)) return block;
    let b = block;
    // «Читать →» отдельной строкой → ссылкой становится заголовок материала.
    const read = b.match(/^[ \t]*<a\s+href="([^"]+)"[^>]*>\s*Читать[^<]*<\/a>[ \t]*$/m);
    if (read) {
      const href = read[1];
      const title = [...b.matchAll(/<b>([\s\S]*?)<\/b>/g)]
        .find((m) => !/^\s*(AI-дайджест|Почему важно)/i.test(m[1]) && !/<a\s/i.test(m[1]));
      if (title && title.index !== undefined) {
        b = b.slice(0, title.index) + `<b><a href="${href}">${title[1]}</a></b>` + b.slice(title.index + title[0].length);
        b = b.replace(read[0], '').replace(/\n{2,}/g, '\n').replace(/\n+$/, '');
      }
    }
    // «Почему важно» — плашкой цитаты с жирной меткой, в каком бы виде его
    // ни вернула модель: строкой или цитатой, с <b>, <strong>, <i> или без
    // выделения (28.09: без <b> пост читался пустым). Вид один на все выпуски.
    b = b.replace(
      /^([ \t]*)(?:<blockquote[^>]*>)?[ \t]*(?:<(?:b|strong|i|em)>)?[ \t]*Почему важно[ \t]*:?[ \t]*(?:<\/(?:b|strong|i|em)>)?[ \t]*:?[ \t]*(.*?)(?:<\/blockquote>)?[ \t]*$/m,
      (_line, pad: string, rest: string) => `${pad}<blockquote><b>Почему важно:</b> ${rest.trim()}</blockquote>`,
    );
    // <strong> в заголовке — тот же жирный; вид один.
    b = b.replace(/<strong>([\s\S]*?)<\/strong>/g, '<b>$1</b>');
    return b;
  }).join('');
}

/**
 * Форма черновика одной строкой — для отказа (28.09). Черновик отвергнутого
 * поста нигде не хранится, и «0 материалов» не говорило, чего именно не
 * хватило: заголовков, ссылок, вывода или всего сразу. Только счёт разметки,
 * без текста: в отчёт идёт форма, а не содержание.
 */
export function aiPostShape(html: string): string {
  const blocks = html.split(/\n\s*\n/).filter((b) => b.trim()).length;
  const bold = boldParts(html).length;
  const links = (html.match(/<a\s+href="/gi) ?? []).length;
  const why = (html.match(/Почему важно/gi) ?? []).length;
  const md = (html.match(/\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:/g) ?? []).length;
  return `знаков ${html.length}, блоков ${blocks}, жирных ${bold}, ссылок ${links}, «Почему важно» ${why}, Markdown ${md}`;
}

/** null — пост дотягивает до выпуска; строка — почему нет. */
export function aiPostTooThin(html: string): string | null {
  const n = aiPostMaterials(html).length;
  if (n >= AI_POST_MIN_MATERIALS) return null;
  return `в посте ${n} полных материалов (заголовок, «Почему важно», ссылка) из ${AI_POST_MIN_MATERIALS} нужных`;
}

/**
 * Дата выпуска по Камчатке. Вечерний прогон стартует после 12:00 UTC, а
 * это уже следующие сутки на Камчатке: пост 26.09 выходил с шапкой «25
 * сентября», потому что дату брали по часам сервера.
 */
export function kamchatkaDate(now: Date, opts: Intl.DateTimeFormatOptions): string {
  return now.toLocaleDateString('ru-RU', { ...opts, timeZone: 'Asia/Kamchatka' });
}
