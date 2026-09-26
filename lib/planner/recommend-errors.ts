/**
 * Ответ формы планера на неверный запрос — словами человека.
 *
 * «Некорректные параметры» не говорили ничего (снимок владельца 26.09: так
 * отвечал выбор 13 интересов при потолке 12). Первая ошибка называется полем
 * формы; потолок интересов — с запасом над числом чипов (14).
 */
import type { z } from 'zod';

export const INTERESTS_MAX = 30;

/** Поле формы — словами человека, для ответа об ошибке. */
const FIELD_LABEL: Record<string, string> = {
  interests: 'Что интересно', arrivalDate: 'Прилёт', departureDate: 'Отъезд',
  flightArrivalTime: 'Время прилёта', flightDepartureTime: 'Время вылета',
  adults: 'Взрослых', children: 'Дети', fitnessLevel: 'Подготовка', budgetTier: 'Бюджет',
  healthNotes: 'Ограничения по здоровью', mobilityLevel: 'Подвижность',
  travelStyle: 'Как ехать', restDays: 'Дни отдыха', riskMode: 'Режим маршрутов',
};

/**
 * «Некорректные параметры» человеку ничего не говорит (снимок владельца 26.09:
 * так отвечал выбор 13 интересов). Первая ошибка — названием поля формы.
 */
export function describeRecommendError(issues: z.ZodIssue[]): string {
  const first = issues[0];
  if (!first) return 'Проверьте заполнение шагов.';
  const field = String(first.path[0] ?? '');
  if (field === 'interests' && first.code === 'too_small') return 'Выберите хотя бы одно место или активность.';
  if (field === 'interests' && first.code === 'too_big') return `Выберите не больше ${INTERESTS_MAX} мест и активностей.`;
  const label = FIELD_LABEL[field];
  return label ? `Проверьте поле «${label}».` : 'Проверьте заполнение шагов.';
}
