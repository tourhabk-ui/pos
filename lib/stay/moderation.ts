/**
 * Модерация объектов жилья (решение владельца 26.09, миграция 1027).
 *
 * Объект виден туристу, только когда ОБА условия истинны:
 *   - is_active            — выключатель владельца («скрыть на время»);
 *   - moderation_status    — 'approved', решение администратора.
 *
 * Условие живёт здесь одной строкой, а не копией в каждом читателе витрины:
 * каталог, карточка, Кузьмич/MCP, планер и sitemap уже однажды жили на
 * «только is_active», и добавить второе условие в пять мест по памяти —
 * значит однажды забыть шестое. Сторож: tests/unit/stay-moderation-gate.test.ts.
 */

export const MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

/**
 * SQL-условие «объект на витрине». Алиас — имя таблицы accommodations в
 * запросе; пустая строка — без префикса. Алиас задаёт код, не пользователь.
 */
export function publicAccommodationSql(alias = 'a'): string {
  if (alias !== '' && !/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`publicAccommodationSql: недопустимый алиас «${alias}»`);
  }
  const p = alias ? `${alias}.` : '';
  return `(${p}is_active = true AND ${p}moderation_status = 'approved')`;
}

/** Что видит владелец о своём объекте. */
export interface OwnerListingState {
  /** Короткая метка для бейджа. */
  label: string;
  /** Пояснение: что происходит и что делать. null — пояснять нечего. */
  detail: string | null;
  tone: 'muted' | 'warning' | 'danger' | 'success';
  /** Виден ли объект туристу прямо сейчас. */
  public: boolean;
}

export function ownerListingState(row: {
  is_active: boolean;
  moderation_status: string;
  moderation_reason: string | null;
}): OwnerListingState {
  const status = row.moderation_status;
  if (status === 'rejected') {
    const reason = row.moderation_reason?.trim();
    return {
      label: 'Отклонено',
      detail: reason
        ? `Причина: ${reason}. Исправьте объект — после правки он снова уйдёт на проверку.`
        : 'Причина не записана — напишите в поддержку.',
      tone: 'danger',
      public: false,
    };
  }
  if (status === 'pending') {
    return {
      label: 'На проверке',
      detail: 'Объект появится на витрине после проверки платформой.',
      tone: 'warning',
      public: false,
    };
  }
  if (status === 'approved') {
    return row.is_active
      ? { label: 'Опубликовано', detail: null, tone: 'success', public: true }
      : { label: 'Скрыто вами', detail: 'Одобрен, но снят с витрины — включите показ, чтобы вернуть.', tone: 'muted', public: false };
  }
  // Статус, которого справочник не знает, — не «опубликовано» (§4.0).
  return { label: 'Статус неизвестен', detail: `Статус «${status}» не распознан — напишите в поддержку.`, tone: 'muted', public: false };
}
