/**
 * Прокат автомобилей: типы и чистое форматирование прайса (схема 1317,
 * решение владельца 23.10 «пока берем аренду автомобилей и трансфер»).
 *
 * Отдельно от rental.ts намеренно: тот читает базу (pg), а карточку рисует и
 * клиентская форма заявки — импорт загрузчика потащил бы драйвер БД в
 * браузерный бандл. Здесь ни сети, ни базы.
 *
 * Прокат — не перевозчик (§14): машина без водителя, цена — за СУТКИ за
 * машину, направление и дни задаёт арендатор, водитель — по желанию и за
 * отдельную плату, которой прайс не называет. Что в цену входит, минимальный
 * срок, возраст и стаж водителя прокатчик платформе не называл — колонок нет,
 * и экран говорит «не записано» (§4.0).
 */

import { formatRub, type CharterLegal, type CharterPhoto } from '@/lib/transfers/charter-format';
import { sellerRequisitesLine } from '@/lib/tours/seller-requisites';

export type RentalBodyKind = 'car' | 'suv' | 'minibus' | 'offroad_truck' | 'vahtovka';
export type RentalTransmission = 'automatic' | 'manual';
export type RentalDrive = '4wd' | 'awd' | '2wd';
/** self — только без водителя; optional — без водителя или с водителем по желанию, цена водителя отдельно. */
export type RentalDriver = 'self' | 'optional';

/** Строка прайса проката — машина или класс машин с ценой за сутки. */
export interface RentalOffer {
  id: string;
  title: string;
  bodyKind: RentalBodyKind;
  /** null — число мест не записано: не ноль и не догадка. */
  seats: number | null;
  transmission: RentalTransmission | null;
  drive: RentalDrive | null;
  engineHp: number | null;
  /** Целые рубли за сутки за машину. */
  priceRubPerDay: number;
  /** Прокатчик назвал цену «от» — точную называет он сам. */
  priceIsFrom: boolean;
  /** null — залог не записан, а не «залога нет». */
  depositRub: number | null;
  driver: RentalDriver;
  /** Условия строки словами прокатчика; null — не записаны. */
  conditions: string | null;
  /** Откуда цена; на экран не выводится, нужна для сверки. */
  sourceUrl: string | null;
  /** YYYY-MM-DD, когда цена сверена; null — не записано. */
  pricesSeenOn: string | null;
  /** Снимок этой машины с подписью (1319); null — снимка нет, строка идёт без него. */
  photo: CharterPhoto | null;
}

/** Прокатчик для витрины /car-rental: только то, что нужно карточке. */
export interface RentalCompany {
  partnerId: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  /** Логотип партнёра — partners.logo_image, путь под public/; null — логотипа нет. */
  logo: string | null;
  /** Герой первым, затем галерея; без повторов. Может быть пусто. */
  photos: CharterPhoto[];
  /** Живые строки прайса в порядке прокатчика. */
  offers: RentalOffer[];
  /** «+7XXXXXXXXXX»; null — не записан. В ответ AI-инструментов не уходит. */
  phone: string | null;
  telegramHref: string | null;
}

/** Условия проката пунктами, словами прокатчика (car_rental_terms). */
export interface RentalTerms {
  items: string[];
  sourceUrl: string | null;
  /** YYYY-MM-DD; null — дата сверки не записана. */
  seenOn: string | null;
}

/**
 * Прокатчик для его страницы /car-rental/[slug]: тот же разбор, что у
 * карточки, плюс то, что нужно только странице.
 */
export interface RentalCompanyProfile extends RentalCompany {
  description: string | null;
  /** partners.is_verified: true — проверен платформой, иначе отметки нет. */
  verified: boolean;
  /** Исполнитель по договору из legal_info; null — реквизиты не записаны. */
  legal: CharterLegal | null;
  /** null — условия на платформе не записаны. */
  terms: RentalTerms | null;
  /** У партнёра есть и живой прайс перевозчика (машина целиком с водителем). */
  alsoCarrier: boolean;
}

/**
 * Что экран знает о прокатчиках: три исхода, не два. Пустой список при `ok` —
 * «искали, никого нет»; `failed` — «не смогли проверить», и экран обязан
 * сказать это вслух, а не промолчать.
 */
export type RentalState = { state: 'ok'; companies: RentalCompany[] } | { state: 'failed' };

/** Адрес страницы прокатчика — один на все ссылки: витрина, планер, сайтмап, переадресация. */
export function rentalPagePath(slug: string): string {
  return `/car-rental/${encodeURIComponent(slug)}`;
}

/** Якорь формы заявки на машину на странице прокатчика. */
export const RENTAL_REQUEST_ANCHOR = 'rental-request';

/**
 * Адрес заявки: форма на странице прокатчика, а с `offerTitle` — уже с
 * выбранной машиной (тот же путь, что у «Заказать» в прайсе перевозчика,
 * владелец 14.10: из прайса к заказу должно вести одно нажатие).
 */
export function rentalOrderPath(slug: string, offerTitle?: string): string {
  const query = offerTitle ? `?car=${encodeURIComponent(offerTitle)}` : '';
  return `${rentalPagePath(slug)}${query}#${RENTAL_REQUEST_ANCHOR}`;
}

/**
 * Машина из адреса заявки (`?car=`) — только строка прайса этого прокатчика,
 * слово в слово. Чужой текст из ссылки машиной не становится.
 */
export function orderOfferFromQuery(offers: ReadonlyArray<Pick<RentalOffer, 'title'>>, car: unknown): string | null {
  const want = Array.isArray(car) ? car[0] : car;
  if (typeof want !== 'string') return null;
  const t = want.trim();
  return offers.some((o) => o.title === t) ? t : null;
}

const BODY_WORDS: Record<RentalBodyKind, string> = {
  car: 'легковая',
  suv: 'внедорожник',
  minibus: 'микроавтобус',
  offroad_truck: 'вездеход',
  vahtovka: 'вахтовка',
};

/** Кузов словом: «внедорожник», «вахтовка». */
export function bodyKindWord(kind: RentalBodyKind): string {
  return BODY_WORDS[kind];
}

export function transmissionWord(t: RentalTransmission): string {
  return t === 'automatic' ? 'автомат' : 'механика';
}

export function driveWord(d: RentalDrive): string {
  return d.toUpperCase();
}

/** Водитель словами: цена водителя прайсом не названа, и это сказано. */
export function driverWord(d: RentalDriver): string {
  return d === 'self' ? 'без водителя' : 'без водителя или с водителем — цена водителя отдельно';
}

/** «7 000 ₽/сутки» или «от 25 000 ₽/сутки». */
export function priceOnScreen(o: Pick<RentalOffer, 'priceRubPerDay' | 'priceIsFrom'>): string {
  return `${o.priceIsFrom ? 'от ' : ''}${formatRub(o.priceRubPerDay)}/сутки`;
}

/** «N мест» / «число мест не записано». */
export function seatsWords(seats: number | null): string {
  if (seats === null) return 'число мест не записано';
  const m10 = seats % 10;
  const m100 = seats % 100;
  const noun = m10 === 1 && m100 !== 11 ? 'место' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'места' : 'мест';
  return `${seats} ${noun}`;
}

/** Самая низкая цена за сутки по прайсу; null — прайса нет. */
export function minRentalPrice(c: Pick<RentalCompany, 'offers'>): number | null {
  return c.offers.length > 0 ? Math.min(...c.offers.map((o) => o.priceRubPerDay)) : null;
}

/** Самый низкий записанный залог; null — залог не записан ни у одной машины. */
export function minRentalDeposit(c: Pick<RentalCompany, 'offers'>): number | null {
  const deposits = c.offers.map((o) => o.depositRub).filter((d): d is number => d !== null);
  return deposits.length > 0 ? Math.min(...deposits) : null;
}

/**
 * Чего на платформе не записано — одной фразой для карточки и страницы: прайс
 * проката называет цену за сутки, но не называет минимального срока аренды,
 * требований к возрасту и стажу водителя, что входит в цену и как застрахована
 * машина. Догадки нет — «уточняется у прокатчика».
 */
export function rentalUnknownsText(): string {
  return 'Минимальный срок аренды, возраст и стаж водителя, что входит в цену и страховка на платформе не записаны — уточняется у прокатчика';
}

/** Строка «Исполнитель: …» — та же, что у тура и перевозчика. null — реквизитов нет. */
export function rentalRequisitesLine(legal: CharterLegal | null): string | null {
  if (!legal) return null;
  return sellerRequisitesLine({ operator_legal_name: legal.name, operator_inn: legal.inn, operator_ogrn: legal.ogrn });
}

/** Факты машины одной строкой для карточки: кузов · места · коробка · привод · л.с. — только записанное. */
export function offerFactsLine(o: RentalOffer): string {
  const parts = [bodyKindWord(o.bodyKind), seatsWords(o.seats)];
  if (o.transmission) parts.push(transmissionWord(o.transmission));
  if (o.drive) parts.push(driveWord(o.drive));
  if (o.engineHp !== null) parts.push(`${o.engineHp} л.с.`);
  return parts.join(' · ');
}
