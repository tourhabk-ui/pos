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
 *
 * ── Правило переехало в общий модуль (26.09) ──────────────────────────────
 *
 * У ПРОКАТА того же дня выяснилось, что шлюза нет вовсе, и `gear_items` имеет
 * те же колонки с тем же смыслом. Дописать прокату свою копию значило бы
 * завести второе правило (§12), поэтому само условие и разбор исходов живут
 * в `lib/moderation/gate.ts`. Здесь остались СЛОВА про жильё: «объект» и
 * «позиция проката» склоняются по-разному, и общая формулировка вышла бы
 * обтекаемой до бессмыслицы.
 */

import { moderatedKind, publicModeratedSql } from '@/lib/moderation/gate';

export { MODERATION_STATUSES, type ModerationStatus } from '@/lib/moderation/gate';

/**
 * SQL-условие «объект на витрине». Алиас — имя таблицы accommodations в
 * запросе; пустая строка — без префикса. Алиас задаёт код, не пользователь.
 */
export function publicAccommodationSql(alias = 'a'): string {
  return publicModeratedSql(alias);
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
  const { kind, public: isPublic } = moderatedKind(row);
  switch (kind) {
    case 'rejected': {
      const reason = row.moderation_reason?.trim();
      return {
        label: 'Отклонено',
        detail: reason
          ? `Причина: ${reason}. Исправьте объект — после правки он снова уйдёт на проверку.`
          : 'Причина не записана — напишите в поддержку.',
        tone: 'danger',
        public: isPublic,
      };
    }
    case 'pending':
      return {
        label: 'На проверке',
        detail: 'Объект появится на витрине после проверки платформой.',
        tone: 'warning',
        public: isPublic,
      };
    case 'published':
      return { label: 'Опубликовано', detail: null, tone: 'success', public: isPublic };
    case 'hidden_by_owner':
      return { label: 'Скрыто вами', detail: 'Одобрен, но снят с витрины — включите показ, чтобы вернуть.', tone: 'muted', public: isPublic };
    default:
      // Статус, которого справочник не знает, — не «опубликовано» (§4.0).
      return {
        label: 'Статус неизвестен',
        detail: `Статус «${row.moderation_status}» не распознан — напишите в поддержку.`,
        tone: 'muted',
        public: isPublic,
      };
  }
}
