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
 * Материалы поста по порядку. Блоки разделены пустой строкой; шапка
 * «AI-дайджест · …» и необязательная цитата-хвост материалами не считаются.
 */
export function aiPostMaterials(html: string): AiMaterial[] {
  const out: AiMaterial[] = [];
  for (const block of html.split(/\n\s*\n/)) {
    const titles = [...block.matchAll(/<b>([\s\S]*?)<\/b>/g)]
      .map((m) => stripTags(m[1]).trim())
      .filter((t) => t && !/^AI-дайджест/i.test(t) && !/^Почему важно/i.test(t));
    const title = titles[0];
    const why = /<b>\s*Почему важно/i.test(block);
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
    // «Почему важно» — плашкой цитаты. Строка, уже начатая <blockquote>,
    // этим шаблоном не ловится (он требует <b> в начале строки).
    b = b.replace(/^([ \t]*)(<b>\s*Почему важно.*)$/m, (_line, pad: string, rest: string) =>
      /<\/blockquote>\s*$/i.test(rest) ? `${pad}${rest}` : `${pad}<blockquote>${rest}</blockquote>`);
    return b;
  }).join('');
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
