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
 *    заголовком.
 */

import { stripTags } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

export interface AiMaterial {
  title: string;
  url: string;
}

/** Минимум материалов в выпуске. */
export const AI_POST_MIN_MATERIALS = 2;

/** Потолок подписи кнопки: длиннее Telegram режет сам, и режет некрасиво. */
export const AI_BUTTON_LABEL_MAX = 40;

// Разворот сущностей — один проход в одном месте (lib/html/entities, сторож
// html-entities): цепочка replace(&amp;)… разворачивала «&amp;lt;» дважды.
const decodeEntities = decodeHtmlEntities;

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
    if (title && why && href) out.push({ title, url: decodeEntities(href) });
  }
  return out;
}

/** null — пост дотягивает до выпуска; строка — почему нет. */
export function aiPostTooThin(html: string): string | null {
  const n = aiPostMaterials(html).length;
  if (n >= AI_POST_MIN_MATERIALS) return null;
  return `в посте ${n} полных материалов (заголовок, «Почему важно», ссылка) из ${AI_POST_MIN_MATERIALS} нужных`;
}

/** Подпись кнопки: целыми словами, с многоточием, если не влезло. */
export function buttonLabel(title: string, max = AI_BUTTON_LABEL_MAX): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.:;—-]+$/, '')}…`;
}

/** Кнопки под постом — по материалам самого поста, не больше трёх. */
export function aiPostButtons(html: string): Array<Array<{ text: string; url: string }>> {
  return aiPostMaterials(html).slice(0, 3).map((m) => [{ text: buttonLabel(m.title), url: m.url }]);
}

/**
 * Дата выпуска по Камчатке. Вечерний прогон стартует после 12:00 UTC, а
 * это уже следующие сутки на Камчатке: пост 26.09 выходил с шапкой «25
 * сентября», потому что дату брали по часам сервера.
 */
export function kamchatkaDate(now: Date, opts: Intl.DateTimeFormatOptions): string {
  return now.toLocaleDateString('ru-RU', { ...opts, timeZone: 'Asia/Kamchatka' });
}
