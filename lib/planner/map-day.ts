/**
 * Что известно о дне, поставленном с карты (разбор планера 14.11, экран-3).
 *
 * День с карты говорил «Средний · для всех возрастов · 3 000 — 8 000 ₽» о
 * восхождении на Ключевскую: сложность и возраст стояли константами, вилка
 * цен была вписана в экран и расходилась с движком (медведи 15–35 тыс. против
 * 15–45 тыс. в таблице). Теперь — та же таблица видов занятий, что у движка
 * (`ACTIVITY_CONSTRAINTS`): справочные сложность, возраст и вилка вида. Вид
 * занятия у маршрута не записан — ничего не утверждается (`detailsUnknown`),
 * цены нет (§4.0).
 *
 * Сторож: tests/unit/planner-map-day.test.ts.
 */
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner/constants';

export interface MapDayDetails {
  priceFrom: number;
  priceTo: number;
  difficulty: 'easy' | 'moderate' | 'hard';
  childFriendly: boolean;
  minChildAge: number;
  /** Вид занятия не записан: сложность, возраст и цена неизвестны. */
  detailsUnknown?: true;
}

export function mapDayDetails(activityType: string | null | undefined): MapDayDetails {
  const c = activityType ? ACTIVITY_CONSTRAINTS[activityType] : undefined;
  if (!c) {
    // Тип поля обязателен; экран вместо него говорит «не записано».
    return { priceFrom: 0, priceTo: 0, difficulty: 'moderate', childFriendly: false, minChildAge: 0, detailsUnknown: true };
  }
  return {
    priceFrom: c.pricePerPerson[0],
    priceTo: c.pricePerPerson[1],
    difficulty: c.difficulty,
    childFriendly: c.minChildAge === 0,
    minChildAge: c.minChildAge,
  };
}
