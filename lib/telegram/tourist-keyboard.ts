/**
 * Клавиатура туриста в @kuzmichai_bot.
 *
 * Кабинет оператора и прокатчика сюда не входит: у них свои кнопки.
 * «Аренда авто» — просьба туриста, не вход в кабинет проката.
 */

import { RENTAL_SITE_PAUSE, rentalSitePauseActive } from '@/lib/rental/site-pause';

export const TOURIST_BUTTONS = [
  'Подобрать тур',
  'Погода',
  'Аренда авто',
  'Операторы',
  'Задать вопрос',
] as const;

export type TouristButton = (typeof TOURIST_BUTTONS)[number];

export function touristReplyMarkup(): {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard: boolean;
  is_persistent: boolean;
} {
  return {
    keyboard: [
      [{ text: 'Подобрать тур' }, { text: 'Погода' }],
      [{ text: 'Аренда авто' }, { text: 'Операторы' }],
      [{ text: 'Задать вопрос' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function matchTouristButton(text: string): TouristButton | null {
  const t = text.trim().toLowerCase().replace(/ё/g, 'е');
  for (const button of TOURIST_BUTTONS) {
    if (button.toLowerCase().replace(/ё/g, 'е') === t) return button;
  }
  return null;
}

/**
 * Ответ на «Аренда авто» туристу.
 *
 * Пауза витрины (lib/rental/site-pause) — людьми на сайте прокатчика не
 * показывают. Имя, машины и цены тогда не называются. Кабинет прокатчика
 * эта строка не открывает.
 */
export function touristRentalText(now: Date = new Date()): string {
  if (rentalSitePauseActive(now)) {
    return 'Прокат автомобилей без водителя на сайте сейчас не показывается — '
      + `вернётся ${RENTAL_SITE_PAUSE.returnsOn}. Прокатчиков и цен не называю: витрина их прячет. `
      + 'Машину с водителем можно смотреть у перевозчиков: https://vedarai.ru/transfers';
  }
  return 'Аренда автомобиля без водителя — на витрине Ведара: https://vedarai.ru/car-rental . '
    + 'Цену берёте с карточки прокатчика, я её от себя не называю.';
}

export const TOURIST_ASK_TEXT = 'Напишите вопрос своими словами. Отвечу по делу: маршрут, сезон, погода или тур из каталога.';
