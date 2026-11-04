/**
 * Программа по дням (operator_tours.program) ↔ текст поля формы кабинета
 * оператора. Разбор — тот же parseProgram, что у правки гида из чата
 * (lib/guides/tour-edit/parse): один формат программы на всех путях записи.
 *
 * Текст: шаг с номера «1. День 1: Выезд из Петропавловска…», продолжение
 * шага — следующими строками без номера. Пустое поле — программы нет (NULL).
 */

import { z } from 'zod';
import { parseProgram, type EditReject } from '@/lib/guides/tour-edit/parse';
import type { TourProgramStep } from '@/lib/tours/tour-write';

/** Программа из базы (jsonb) → текст поля. Не список — пустая строка. */
export function programToText(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((s, i) => {
      const o = (s && typeof s === 'object' ? s : { title: String(s ?? ''), text: '' }) as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      const text = typeof o.text === 'string' ? o.text.trim() : '';
      if (!title && !text) return null;
      return `${i + 1}. ${title || 'Шаг ' + (i + 1)}${text ? `: ${text}` : ''}`;
    })
    .filter((x): x is string => x !== null)
    .join('\n');
}

export type ProgramFromText =
  | { ok: true; value: TourProgramStep[] | null }
  | { ok: false; error: string };

function rejectText(r: EditReject): string {
  switch (r.reason) {
    case 'too_many': return `Программа: не больше ${r.max} шагов, сейчас ${r.got}.`;
    case 'item_too_long': return `Программа, шаг ${r.index}: слишком длинно (не больше ${r.max} символов).`;
    case 'step_no_title': return `Программа, шаг ${r.index}: начните шаг с короткого заголовка и двоеточия — «День 1: …».`;
    default: return 'Программа не разобрана: каждый шаг — с номера, «1. День 1: …».';
  }
}

/** Текст поля → программа для PATCH. Пусто — null (программы нет). */
export function programFromText(text: string): ProgramFromText {
  if (!text.trim()) return { ok: true, value: null };
  const r = parseProgram(text);
  if ('value' in r) return { ok: true, value: r.value };
  return { ok: false, error: rejectText(r) };
}

/** Программа в теле PATCH (кабинет оператора и «Свои туры» гида): шаги parseProgram. */
export const ProgramStepsSchema = z.array(z.object({
  title: z.string().trim().min(1).max(200),
  text:  z.string().max(3000),
})).max(20).nullable();
