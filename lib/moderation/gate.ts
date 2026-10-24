/**
 * Шлюз витрины: что партнёр завёл — и что из этого видит турист.
 *
 * ── Почему один модуль на жильё и прокат (26.09) ──────────────────────────
 *
 * Правило «на витрине то, что партнёр не скрыл И администратор одобрил»
 * появилось у жилья (миграция 1027) и было написано там же, в
 * `lib/stay/moderation.ts`. У проката того же дня выяснилось, что правила нет
 * вовсе: позиция попадала в публичный каталог сразу, а профиль прокатчика
 * заводился сам читающим запросом.
 *
 * Дописывать прокату СВОЮ копию значило бы завести второе правило (§12) — и
 * разойтись им было бы легко: у жилья условие уже стоит в шести читателях
 * витрины, у проката встало бы в своих. Поэтому условие и разбор исходов
 * живут здесь, а домены дают только СЛОВА.
 *
 * Возможным это делает совпадение схемы: у `accommodations` и `gear_items`
 * одни и те же колонки-шлюзы (`is_active`, `moderation_status`) и один и тот
 * же смысл. Появись третья витрина с другими именами — она получит здесь
 * свой алиас, а не своё правило.
 *
 * Черновик правки прайса проката (`rental_offer_edits`) — не третья витрина:
 * у него нет `is_active`, и сам черновик турист не видит. Решение «применить
 * правку к живой строке» — тот же `moderatedKind`: published, и только он.
 *
 * ── Чего здесь нет ────────────────────────────────────────────────────────
 *
 * Текстов для человека. «Объект» и «позиция» склоняются по-разному, и общая
 * формулировка вышла бы такой обтекаемой, что перестала бы что-либо значить.
 * Домен получает РОД исхода и говорит о нём своими словами.
 */

export const MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

/**
 * SQL-условие «запись на витрине». Алиас — имя таблицы в запросе; пустая
 * строка — без префикса. Алиас задаёт код, не пользователь, и всё же
 * проверяется: подстановка в SQL без проверки — привычка, которая однажды
 * встретит строку из запроса.
 */
export function publicModeratedSql(alias: string): string {
  if (alias !== '' && !/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`publicModeratedSql: недопустимый алиас «${alias}»`);
  }
  const p = alias ? `${alias}.` : '';
  return `(${p}is_active = true AND ${p}moderation_status = 'approved')`;
}

/**
 * Род исхода для владельца записи.
 *
 * `unknown` — статус, которого справочник не знает. Это НЕ «опубликовано»:
 * неизвестное состояние, выданное за готовность, — та самая подмена третьего
 * исхода первым (§4.0).
 */
export type ListingKind =
  | 'rejected'
  | 'pending'
  | 'published'
  | 'hidden_by_owner'
  | 'unknown';

export interface ModeratedKind {
  kind: ListingKind;
  /** Видна ли запись туристу прямо сейчас. */
  public: boolean;
}

export function moderatedKind(row: {
  is_active: boolean;
  moderation_status: string;
}): ModeratedKind {
  switch (row.moderation_status) {
    case 'rejected': return { kind: 'rejected', public: false };
    case 'pending':  return { kind: 'pending', public: false };
    case 'approved': return row.is_active
      ? { kind: 'published', public: true }
      : { kind: 'hidden_by_owner', public: false };
    default: return { kind: 'unknown', public: false };
  }
}

/**
 * Черновик можно перенести на живую строку только когда решение — «опубликовано».
 * pending, rejected и неизвестный статус правку не применяют: третьего исхода
 * «раз статус не тот, значит уже на сайте» здесь нет.
 */
export function draftMayApply(status: string): boolean {
  return moderatedKind({ is_active: true, moderation_status: status }).kind === 'published';
}
