/**
 * Как турист попадает на тур — один словарь на все поверхности.
 *
 * Поле заведено миграцией 932. До неё этот вопрос отвечался колонкой
 * `meeting_point`, и она отвечала не на тот вопрос: у восьми живых туров она
 * была пуста, а перепись готовности считала это забывчивостью оператора.
 * Владелец 23.08 поправил — операторы забирают туристов сами, фиксированной
 * точки сбора у таких туров нет и быть не должно. Значит покупателю нужно
 * знать не «где точка сбора», а «меня заберут, я приду или еду сам»: у этих
 * трёх ответов разная цена поездки, разный багаж и разное решение о покупке.
 *
 * Словарь один на карточку, Кузьмича, структурные данные и кабинет: правило,
 * записанное в трёх местах, — это три правила, и они разойдутся (так уже было
 * со стилем линии на карте, §12).
 */

export type PickupType = 'hotel_pickup' | 'meeting_point' | 'self_drive';

export const PICKUP_TYPES: readonly PickupType[] = ['hotel_pickup', 'meeting_point', 'self_drive'];

export function isPickupType(v: unknown): v is PickupType {
  return typeof v === 'string' && (PICKUP_TYPES as readonly string[]).includes(v);
}

interface PickupWording {
  /** Заголовок блока на карточке. */
  title: string;
  /** Одна строка сути — она же идёт в ответ Кузьмича и в чужую витрину. */
  summary: string;
  /** Чего не хватает, когда подробностей нет. Пусто — подробности не нужны. */
  detailsNeeded: string;
}

const WORDING: Record<PickupType, PickupWording> = {
  hotel_pickup: {
    title: 'Вас заберут',
    summary: 'Оператор забирает туриста сам — своим ходом добираться не нужно.',
    detailsNeeded: 'откуда именно забирают',
  },
  meeting_point: {
    title: 'Встреча в назначенном месте',
    summary: 'Турист приходит к месту сбора, дальше группа едет вместе.',
    detailsNeeded: 'адрес и время сбора',
  },
  self_drive: {
    // Подробности здесь необязательны: куда ехать, отвечают координаты тура.
    // Требовать их значило бы просить оператора написать то, что уже записано
    // в другом поле, а потом краснеть переписью на пустом месте.
    title: 'Добираетесь сами',
    summary: 'Турист приезжает к месту старта самостоятельно.',
    detailsNeeded: '',
  },
};

export function pickupWording(type: PickupType): PickupWording {
  return WORDING[type];
}

/**
 * Что показать на карточке. `null` — блок не рисуется вовсе.
 *
 * Молчание здесь намеренное и то же, что у условий отмены (931): не записано
 * — значит не записано. Подставить «уточните у оператора» вместо ответа
 * означало бы выдать нашу неосведомлённость за условие тура.
 */
export function pickupForCard(
  type: unknown,
  details: string | null | undefined,
  legacyMeetingPoint?: string | null,
): { title: string; summary: string; lines: string[] } | null {
  if (!isPickupType(type)) return null;
  const w = WORDING[type];
  // Старые туры: подробности могли остаться только в meeting_point. Миграция
  // переносит их, но карточка не обязана верить, что перенос везде прошёл.
  const raw = (details ?? '').trim() || (type === 'meeting_point' ? (legacyMeetingPoint ?? '').trim() : '');
  const lines = raw ? raw.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  return { title: w.title, summary: w.summary, lines };
}
