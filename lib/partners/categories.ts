/**
 * lib/partners/categories.ts
 *
 * Единый справочник категорий партнёра — то, что кладётся в `partners.category`.
 *
 * Повод: форма самостоятельной регистрации оператора предлагала `hotel`, `rent`
 * и `fishing`. Ни одного из этих значений нет ни в `PARTNER_ROLES`, ни в карте
 * кабинетов `ROLE_HUB`, ни в CHECK-ограничении колонки. То есть три варианта из
 * шести вели в отказ базы при отправке формы — выбор был, услуги за ним не было.
 *
 * Источник правды — `PARTNER_ROLES`: это ровно те категории, у которых есть
 * рабочий кабинет. Здесь к ним добавляются только человеческие названия, а не
 * второй список: разъехаться им теперь негде.
 *
 * Категории без кабинета (`souvenir`, `cars`, `restaurant` — они есть в схеме)
 * сюда намеренно не попадают: завести партнёра, которому некуда войти, значит
 * снова сделать выбор без услуги за ним.
 */

import { PARTNER_ROLES } from '@/lib/auth/role-routes';

export type PartnerCategory = (typeof PARTNER_ROLES)[number];

export const PARTNER_CATEGORY_LABELS: Record<PartnerCategory, string> = {
  operator: 'Туроператор — экскурсии и туры',
  guide:    'Гид',
  transfer: 'Трансфер и перевозки',
  agent:    'Турагент',
  stay:     'Жильё — база, гостевой дом, глэмпинг',
  gear:     'Прокат снаряжения',
};

export const PARTNER_CATEGORIES: readonly PartnerCategory[] = PARTNER_ROLES;

export function isPartnerCategory(v: unknown): v is PartnerCategory {
  return typeof v === 'string' && (PARTNER_ROLES as readonly string[]).includes(v);
}

/**
 * Старые значения формы регистрации → канонические.
 *
 * Нужны, чтобы уже сохранённые ссылки и открытые вкладки со старым значением
 * не отдавали пятисотку, а приземлялись в осмысленную категорию.
 */
export const LEGACY_CATEGORY_ALIASES: Record<string, PartnerCategory> = {
  hotel:   'stay',
  rent:    'gear',
  fishing: 'operator',
};

export function normalizePartnerCategory(v: string): PartnerCategory | null {
  if (isPartnerCategory(v)) return v;
  return LEGACY_CATEGORY_ALIASES[v] ?? null;
}
