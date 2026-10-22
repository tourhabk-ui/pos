/**
 * Параметры адреса публичного GET — проверка ДО базы (ревью #2642, третий круг).
 *
 * Повод. Публичные отборы туров (поиск, календарь, туры дня) научились честно
 * говорить об отказе базы: 500 «временно не работает, попробуйте позже» и
 * строка в логе с SQLSTATE. Но неверный ВХОД доходил до базы тем же путём:
 * `?page=0` давал `OFFSET -20` (2201X), `?limit=-1` — 2201W, `?page=abc` в
 * ветке AI-тегов — `NaN` в bigint (22P02), несуществующий день `2099-02-30` —
 * 22008, символ NUL в тексте — 22021. Человек получал «временно», хотя повтор
 * ничего не изменит, а лог отказов базы заполнялся чужими опечатками — и
 * настоящий отказ тонул в них.
 *
 * Правило: что можно проверить без базы, проверяется без неё. Неверный
 * параметр — 400 с его именем и словами, как правильно; база не
 * спрашивается, отказ не логируется. 500 «временно» остаётся только отказу
 * базы.
 */
import { z } from 'zod';
import { isRealDate } from '@/lib/analytics/kamchatka-day';

/**
 * Значения параметров из адреса. Пустой параметр — как отсутствующий:
 * `?page=` значит «не задано», а не «страница с пустым номером» (так роуты
 * читали его и раньше).
 */
export function queryInput<K extends string>(
  sp: URLSearchParams,
  keys: readonly K[],
): Record<K, string | undefined> {
  const out = {} as Record<K, string | undefined>;
  for (const k of keys) {
    const v = sp.get(k);
    out[k] = v === null || v === '' ? undefined : v;
  }
  return out;
}

/** Текст, который можно отдать PostgreSQL: символ NUL база не принимает (22021). */
export const queryText = z.string().refine((s) => !s.includes('\u0000'));

/** Целое из адреса: только цифры (без знака, дроби и `1e3`), затем границы. */
export function wholeNumber(min: number, max: number) {
  return z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));
}

/**
 * Неотрицательное число из адреса: цифры и, может быть, дробь через точку.
 * Знак, запятая, `Infinity`, `1e3`, `0x10` — не числа этого адреса.
 */
export const nonNegativeAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .transform(Number)
  .pipe(z.number().min(0));

/** День календаря `ГГГГ-ММ-ДД`: форма и сверка с календарём (2099-02-30 — нет). */
export const calendarDay = z.string().refine(isRealDate);

/** Месяц `ГГГГ-ММ`: месяц 01–12 и год, у которого первое число — день календаря. */
export const calendarMonth = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine((m) => isRealDate(`${m}-01`));

/**
 * Первый неверный параметр — его имя и фраза для человека. Фраза — из карты
 * роута; ключи карты — ровно ключи схемы, и параметра без фразы не бывает.
 */
export function badQueryParam<K extends string>(
  error: z.ZodError,
  texts: Record<K, string>,
): { param: K; error: string } | null {
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(texts, key)) {
      return { param: key as K, error: texts[key as K] };
    }
  }
  return null;
}
