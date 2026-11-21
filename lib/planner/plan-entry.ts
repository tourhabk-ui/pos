/**
 * Куда ведёт кнопка «Собрать план» на главной (21.11).
 *
 * Планер /planner — только после входа (lib/planner/login-gate), и гость с
 * главной упирался в экран «войдите». Гостю — план прямо в чате Кузьмича
 * (/kuzmich?ask=…: вопрос уходит сам), вошедшему — планер. «Не знаем, вошёл
 * ли» (null, сеть) — тоже чат: он работает без входа, а планер без входа нет.
 *
 * Чистый модуль, без базы: его читают клиентские кнопки главной.
 */
import { kuzmichAskHref } from '@/lib/kuzmich/ask-link';
import { PLANNER_PATH } from '@/lib/planner/login-gate';

/** Вопрос, с которым гость попадает в чат: Кузьмич уточнит даты и состав. */
export const GUEST_PLAN_ASK = 'Собери мне план поездки на Камчатку по дням';

export function planEntryHref(authed: boolean | null): string {
  return authed === true ? PLANNER_PATH : kuzmichAskHref(GUEST_PLAN_ASK);
}
