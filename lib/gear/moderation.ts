/**
 * Модерация позиций проката (решение владельца 26.09, миграция 1030).
 *
 * Позиция видна туристу, только когда ОБА условия истинны:
 *   - is_active         — выключатель партнёра («снять с проката на время»);
 *   - moderation_status — 'approved', решение администратора.
 *
 * Условие и разбор исходов берутся из `lib/moderation/gate.ts` — того же, что
 * судит жильё: у `gear_items` и `accommodations` одни колонки-шлюзы и один
 * смысл, и вторая копия правила разошлась бы с первой (§12). Здесь только
 * слова про прокат.
 *
 * ── Что было до этого дня ─────────────────────────────────────────────────
 *
 * Шлюза не было вовсе, и рядом стояла вторая открытая дверь:
 * `GET /api/gear/profile` заводил партнёра `category='gear'` любому вошедшему
 * (`ensureGearPartnerExists`), после чего `POST /api/gear/items` его пропускал.
 * Та функция была вдобавок вторым создателем партнёра рядом с общим
 * `ensurePartnerForRole` — и в отличие от него не спрашивала `PARTNER_ROLES`.
 * С отключением обеих дверей она осталась без вызовов и удалена (§12).
 * Публичный каталог смотрел только `is_active AND available_quantity > 0`.
 * То есть турист за два запроса выставлял снаряжение на витрину платформы,
 * которая обещает проверенных партнёров.
 *
 * ── Что с уже заведённым ──────────────────────────────────────────────────
 *
 * Миграция 1030 пометила ВСЕ прежние позиции `approved`: до 26.09 заведение и
 * БЫЛО публикацией, и прятать живой каталог задним числом нельзя. Значит
 * среди одобренных «до проверки» могут быть и заведённые через дыру.
 * Автоматически отличить их не от чего — признака самозванца в данных нет, —
 * поэтому разбор глазами, а вот с чего начать:
 *
 *   SELECT gi.id, gi.name, p.name AS partner, p.is_verified, gi.created_at
 *     FROM gear_items gi
 *     JOIN partners p ON p.id = gi.partner_id
 *    WHERE gi.moderation_status = 'approved'
 *      AND gi.moderated_at IS NULL      -- решения человека не было
 *      AND COALESCE(p.is_verified, false) = false
 *    ORDER BY gi.created_at DESC;
 *
 * Непроверенный партнёр с позицией на витрине — не приговор (отметку
 * «Проверено» до 26.09 не ставил никто), но это и есть тот список, в котором
 * самозванец окажется, если он есть.
 */

import { moderatedKind, publicModeratedSql } from '@/lib/moderation/gate';

export { MODERATION_STATUSES, type ModerationStatus } from '@/lib/moderation/gate';

/**
 * SQL-условие «позиция на витрине». Алиас — имя таблицы gear_items в запросе;
 * пустая строка — без префикса. Алиас задаёт код, не пользователь.
 */
export function publicGearSql(alias = 'gi'): string {
  return publicModeratedSql(alias);
}

/** Что видит партнёр о своей позиции. */
export interface GearListingState {
  label: string;
  /** Пояснение: что происходит и что делать. null — пояснять нечего. */
  detail: string | null;
  tone: 'muted' | 'warning' | 'danger' | 'success';
  /** Видна ли позиция туристу прямо сейчас. */
  public: boolean;
}

export function gearListingState(row: {
  is_active: boolean;
  moderation_status: string;
  moderation_reason: string | null;
}): GearListingState {
  const { kind, public: isPublic } = moderatedKind(row);
  switch (kind) {
    case 'rejected': {
      const reason = row.moderation_reason?.trim();
      return {
        label: 'Отклонено',
        detail: reason
          ? `Причина: ${reason}. Исправьте позицию — после правки она снова уйдёт на проверку.`
          : 'Причина не записана — напишите в поддержку.',
        tone: 'danger',
        public: isPublic,
      };
    }
    case 'pending':
      return {
        label: 'На проверке',
        detail: 'Позиция появится в каталоге после проверки платформой.',
        tone: 'warning',
        public: isPublic,
      };
    case 'published':
      return { label: 'В каталоге', detail: null, tone: 'success', public: isPublic };
    case 'hidden_by_owner':
      return {
        label: 'Снято вами',
        detail: 'Одобрена, но снята с проката — включите показ, чтобы вернуть.',
        tone: 'muted',
        public: isPublic,
      };
    default:
      // Статус, которого справочник не знает, — не «в каталоге» (§4.0).
      return {
        label: 'Статус неизвестен',
        detail: `Статус «${row.moderation_status}» не распознан — напишите в поддержку.`,
        tone: 'muted',
        public: isPublic,
      };
  }
}
