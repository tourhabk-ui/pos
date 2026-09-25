/**
 * Что показать в раскрытой строке предупреждения на главной.
 *
 * Свёрнутая строка — заголовок до трёх строк; раскрытая добавляет деталь из
 * `description`. У сводок МЧС описание часто НАЧИНАЕТСЯ с заголовка (заголовок
 * — первые слова того же текста), и тогда показать оба значит напечатать
 * одну фразу дважды. В этом случае описание заменяет заголовок.
 *
 * Описания нет или оно пустое — раскрытие показывает заголовок целиком и
 * больше ничего не выдумывает.
 */
import { clip } from '@/components/safety/LiveStatus';

/** Потолок раскрытого текста: главная не подменяет /safety. */
export const ALERT_BODY_MAX = 600;

export interface AlertBody {
  /** Текст детали; null — показывать нечего, кроме заголовка. */
  text: string | null;
  /** Описание продолжает заголовок — печатать вместо него, а не под ним. */
  replacesTitle: boolean;
}

const norm = (t: string): string => t.replace(/[\s.…]+$/u, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function alertBody(a: { title: string; description: string | null }): AlertBody {
  const d = (a.description ?? '').trim();
  if (!d) return { text: null, replacesTitle: false };
  const title = norm(a.title);
  const desc = norm(d);
  if (desc === title) return { text: null, replacesTitle: false };
  // Заголовок — начало описания (с многоточием на конце или без).
  const head = title.slice(0, Math.min(title.length, 60));
  const replacesTitle = head.length >= 12 && desc.startsWith(head);
  return { text: clip(d, ALERT_BODY_MAX), replacesTitle };
}
