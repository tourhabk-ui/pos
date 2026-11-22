/**
 * lib/safety/emergency-numbers.ts
 *
 * ЕДИНЫЙ ИСТОЧНИК экстренных номеров для показа пользователю.
 * Чистая константа, без БД и сети — работает офлайн и в PWA.
 *
 * Почему только федеральные короткие номера:
 * Региональные линии Камчатки (ГУ МЧС, ПСО/ПАСС/ЭКОСПАС) были зашиты в коде
 * ВРАЗНОБОЙ — один «МЧС» показывался пятью разными номерами на разных экранах
 * (23-53-62, 29-99-99, 11-05-05, 41-17-17, 41-27-70). Владелец подтвердить
 * верные номера не смог. Показывать НЕВЕРНЫЙ номер в ЧП опаснее, чем не
 * показывать ничего: человек в беде дозвонится не туда и потеряет время.
 *
 * Федеральные короткие номера (112/101/102/103) едины по всей России, работают
 * с любого мобильного без баланса и SIM, и 112 сам переключает на нужную
 * службу. Это НЕ угадывание — это национальный стандарт.
 *
 * Региональные номера добавляются ТОЛЬКО после верификации владельцем — здесь,
 * в VERIFIED_REGIONAL. Тогда они появятся на всех экранах разом.
 * См. также lib/services/emergency-contacts.ts + миграция 722 (source='verified').
 */

import {
  CUKS_CONSULT_PHONE,
  CUKS_DUTY_PHONE,
  CUKS_DUTY_RESERVE_PHONE,
  FEDERAL_EMERGENCY_NUMBERS,
} from '@/lib/facts/kamchatka';

export interface EmergencyNumber {
  /** Что за служба — подпись в UI */
  name: string;
  /** Номер как для показа, так и для tel: (короткие номера без пробелов) */
  phone: string;
  /** Тип/бейдж */
  type: string;
  /** Главный номер — крупный акцент в UI */
  primary?: boolean;
  /** Короткая подсказка (опционально) */
  hint?: string;
}

/**
 * Федеральные короткие номера РФ. Едины по всей стране, всегда актуальны.
 */
export const FEDERAL_EMERGENCY: EmergencyNumber[] = [
  {
    name: 'Спасение · полиция · скорая',
    phone: FEDERAL_EMERGENCY_NUMBERS.value[0],
    type: 'Единый номер',
    primary: true,
    hint: 'Работает без баланса и SIM. Дозвонится и переключит на нужную службу.',
  },
  { name: 'Пожарные и спасатели (МЧС)', phone: FEDERAL_EMERGENCY_NUMBERS.value[1], type: 'МЧС' },
  { name: 'Полиция', phone: FEDERAL_EMERGENCY_NUMBERS.value[2], type: 'Полиция' },
  { name: 'Скорая помощь', phone: FEDERAL_EMERGENCY_NUMBERS.value[3], type: 'Медицина' },
];

/** Главный номер — для мест, где нужен один акцентный контакт. */
export const EMERGENCY_PRIMARY: EmergencyNumber = FEDERAL_EMERGENCY[0];

/**
 * Региональные экстренные линии Камчатки — только подтверждённые по
 * официальной странице ГУ МЧС (FAQ о связи при ЧП с туристами, сверка
 * 23.11.2026). 200-112 — старший оперативный дежурный ЦУКС; 30-10-89 —
 * начальник дежурной смены ЦУКС. Номер 30-10-91 убран: на страницах
 * ведомства он не найден.
 */
export const VERIFIED_REGIONAL: EmergencyNumber[] = [
  {
    name: 'Старший оперативный дежурный ЦУКС МЧС',
    phone: CUKS_DUTY_RESERVE_PHONE.value,
    type: 'МЧС',
  },
  {
    name: 'Начальник дежурной смены ЦУКС',
    phone: CUKS_DUTY_PHONE.value,
    type: 'МЧС',
  },
];

/** Полный список для показа = федеральные короткие + проверенные региональные. */
export const EMERGENCY_NUMBERS: EmergencyNumber[] = [
  ...FEDERAL_EMERGENCY,
  ...VERIFIED_REGIONAL,
];

/**
 * Номер из данных места — только если он среди проверенных владельцем.
 *
 * Колонку location_safety_profile.phone_ranger_mches не пишет ни один путь в
 * коде (16.10): что в ней лежит, никем не сверено, а карточка места и её PDF
 * печатали её кнопкой «МЧС». Номер вне VERIFIED_REGIONAL не показывается —
 * правило то же, что у всех экранов: проверенный номер добавляется сюда, и
 * тогда он появится везде разом.
 */
export function verifiedRegionalNumber(phone: string | null | undefined): EmergencyNumber | null {
  const norm = (p: string) => {
    const d = p.replace(/\D/g, '');
    return d.length === 11 && (d.startsWith('7') || d.startsWith('8')) ? d.slice(1) : d;
  };
  const want = norm(phone ?? '');
  if (!want) return null;
  return VERIFIED_REGIONAL.find((n) => norm(n.phone) === want) ?? null;
}

/** Только цифры для tel:/sms: (short-номера уже чистые). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/**
 * Проверенные справочные линии — НЕ экстренные: на экранах SOS не показываются,
 * но Кузьмичу называть их можно, и проверки ответов (safety-eval, red-team)
 * их принимают.
 *
 * ЦУКС ГУ МЧС Камчатки +7 (4152) 30-10-81 сверен 22.10.2026 по официальной
 * странице https://41.mchs.gov.ru/deyatelnost/poleznaya-informaciya/registraciya-turisticheskih-grupp
 * («сотрудники ЦУКС … предоставляют консультации по заполнению маршрутного
 * листа, по действующим на маршруте предупреждениям … по тел.: +7(4152)30-10-81»).
 * Одобрено владельцем 22.10.2026. Тот же номер в реестре 722 (cuks, registration).
 */
export const VERIFIED_REFERENCE: EmergencyNumber[] = [
  {
    name: 'ЦУКС ГУ МЧС Камчатки — консультации по маршрутному листу и предупреждениям на маршруте',
    phone: CUKS_CONSULT_PHONE.value,
    type: 'МЧС',
  },
];

/**
 * Номер из данных маршрута (`kamchatka_routes.mchs_phone`) — только если он
 * среди проверенных: региональных экстренных или справочных (ЦУКС). Колонку
 * заполнял импорт с чужих страниц, номера никто не сверял, а Кузьмич диктовал
 * их для регистрации (разбор 19.11, #3179 п.1). Непроверенный номер — null:
 * строки с телефоном нет, ответ называет 112 и форму МЧС.
 */
export function verifiedRouteMchsPhone(phone: string | null | undefined): EmergencyNumber | null {
  const norm = (p: string) => {
    const d = p.replace(/\D/g, '');
    return d.length === 11 && (d.startsWith('7') || d.startsWith('8')) ? d.slice(1) : d;
  };
  const want = norm(phone ?? '');
  if (!want) return null;
  return [...VERIFIED_REGIONAL, ...VERIFIED_REFERENCE].find((n) => norm(n.phone) === want) ?? null;
}
