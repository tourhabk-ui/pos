/**
 * Описание страницы для поиска (meta description, og:description).
 *
 * Аудит SEO 29.09 (Н11): у всех 379 мест описание было ровно 150 знаков, у 389
 * маршрутов — 180, и у 374 мест оно обрывалось посреди слова: `slice(0, 150)`.
 * Сниппет с обрывком слова читается как ошибка сайта.
 *
 * Правило: теги снимаются, пробелы схлопываются; текст длиннее лимита режется
 * по концу предложения, если оно кончается не раньше 40% лимита, иначе — по
 * границе слова с многоточием. Пустой вход — пустая строка: подставить
 * «красивую» заглушку решает вызывающий, эта функция текст не сочиняет (§4.0).
 */
import { stripTags } from '@/lib/html/text';

export const META_DESCRIPTION_MAX = 160;

export function metaDescription(text: string | null | undefined, max: number = META_DESCRIPTION_MAX): string {
  const t = stripTags(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const lastEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.endsWith('.') ? head.length - 1 : -1);
  if (lastEnd >= Math.floor(max * 0.4)) return head.slice(0, lastEnd + 1);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s,;:—–-]+$/u, '')}…`;
}
