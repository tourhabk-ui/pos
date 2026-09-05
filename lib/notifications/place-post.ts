/**
 * Пост о месте для канала — из данных, без модели.
 *
 * Решение владельца 05.09. В канал ушёл пост про озеро Зелёное: «кратер
 * потухшего грязевого вулкана», «термофильные водоросли и растворённое
 * железо», «вода тёплая на ощупь», «под ногами дышит земля». В базе про это
 * место записано другое и меньше: «небольшой водоём, вода зеленоватого
 * оттенка от водорослей и минеральных взвесей, попутная точка на маршруте к
 * Мутновскому, купание не рекомендуется». Всё остальное модель сочинила —
 * при промпте, который прямо запрещал выдумывать. Это третий случай подряд
 * (12.07 обещание трека, 19.08 «секрет» с уходом с тропы, 05.09 фактура
 * места), и вывод один и тот же, он записан в CLAUDE.md §8: инструкция в
 * промпте — не сторож. Отсюда сторож структурный: у поста о месте модели нет
 * вовсе. Текст собирается из полей записи, и придумать ему неоткуда.
 *
 * Фото — тот же принцип, той же датой: снимок ЧУЖОГО места с оговоркой
 * «не это место» владелец снял вместе с постом. Оговорка честна, но читатель
 * видит фото над текстом и делает единственный вывод. Поэтому место без
 * своего снимка в канал не идёт — выбор кандидата это условие держит в SQL
 * (postKuzmichRoute), здесь только текст.
 */

export interface PlacePostSource {
  id: string;
  title: string;
  description: string | null;
  /** Есть ли у страницы GPS-трек — от этого зависит, что пост обещает. */
  has_track: boolean;
}

export interface PlacePostOptions {
  appUrl: string;
  /** Подпись типа локации (уже по-русски) — пусто, если типа нет. */
  locLabel?: string;
  /** Подпись типа активности — пусто, если типа нет. */
  actLabel?: string;
  /** Верхняя граница описания в посте, знаков. */
  maxDescription?: number;
}

export const PLACE_POST_MAX_DESCRIPTION = 700;

/**
 * Строка про страницу — ровно то, что там есть. Без трека слова «трек» и
 * «маршрут» не звучат вовсе: promisesRouteOrTrack ловит их как обещание.
 */
export const PLACE_LINK_LINE = {
  track:   'GPS-трек и карта — на странице места:',
  noTrack: 'Описание и точка на карте — на странице места:',
} as const;

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Обрезает по границе предложения, не по слову: оборванная фраза читается
 * как ошибка, а недосказанное предложение — как выбор.
 */
export function clipToSentence(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const lastEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (lastEnd >= Math.floor(max * 0.4)) return head.slice(0, lastEnd + 1);
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > 0 ? head.slice(0, lastSpace) : head).replace(/[,;:—-]\s*$/, '') + '…';
}

/**
 * Собирает пост. Возвращает null, если описания нет: без него посту нечего
 * сказать, а «место, которое стоит посмотреть» — это заглушка, не пост.
 */
export function composePlacePost(src: PlacePostSource, opts: PlacePostOptions): string | null {
  const description = src.description?.trim();
  if (!description) return null;

  const labels = [opts.locLabel, opts.actLabel].filter((s): s is string => !!s && s.trim().length > 0);
  const lines: string[] = [];
  lines.push(`<b>${escHtml(src.title.trim())}</b>`);
  if (labels.length > 0) lines.push(`<i>${escHtml(labels.join(' · '))}</i>`);
  lines.push('');
  lines.push(escHtml(clipToSentence(description, opts.maxDescription ?? PLACE_POST_MAX_DESCRIPTION)));
  lines.push('');
  lines.push(src.has_track ? PLACE_LINK_LINE.track : PLACE_LINK_LINE.noTrack);
  lines.push(`${opts.appUrl.replace(/\/+$/, '')}/routes/${src.id}`);
  return lines.join('\n');
}
