/**
 * Кто из гидов виден туристу — одно условие на всю платформу.
 *
 * Решение владельца (пакет A, 25.09): публичный реестр `/guides` показывает
 * ТОЛЬКО гидов, одобренных платформой (администратор нажал «одобрить» в
 * очереди заявок), а не ~112 записей, скачанных импортом из реестра края.
 *
 * До этого три места — список `/guides`, профиль `/guides/[id]` и перепись
 * `/api/cron/guide-readiness` — держали по своей копии условия
 * `profile_status = 'active'`. CHECK колонки такого значения не допускает
 * (`none/pending/approved/rejected`), поэтому все три отбирали ноль ПО
 * ПОСТРОЕНИЮ: страница «Реестр гидов скоро будет опубликован» и перепись с
 * `meaningful: false` были не фактом о гидах, а фактом о запросе.
 *
 * Условие здесь, а не три копии: копии уже разошлись со схемой одинаково, и
 * следующая правка обязана случиться в одном месте. Сторож —
 * `tests/unit/guide-pack-a.test.ts`.
 *
 * Что значит каждое слагаемое:
 * - `category = 'guide'` — запись гида, а не оператора;
 * - `profile_status = 'approved'` — заявку одобрил администратор
 *   (`PATCH /api/admin/operators/[id]`, общая очередь партнёров);
 * - `is_public = TRUE` — одобрение ставит его само; снятие — способ спрятать
 *   гида, не отзывая одобрения;
 * - `status` не `suspended`/`rejected` — приостановленный партнёр не
 *   показывается, даже если когда-то был одобрен.
 */

export const PUBLIC_GUIDE_PROFILE_STATUS = 'approved' as const;

/**
 * SQL-условие видимости гида для таблицы partners под псевдонимом `alias`.
 * Параметров не берёт — только константы; псевдоним проверяется, чтобы в
 * текст запроса не попало ничего, кроме имени.
 */
export function publicGuideWhere(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) {
    throw new Error(`publicGuideWhere: недопустимый псевдоним «${alias}»`);
  }
  return `${alias}.category = 'guide'
     AND ${alias}.profile_status = '${PUBLIC_GUIDE_PROFILE_STATUS}'
     AND ${alias}.is_public = TRUE
     AND COALESCE(${alias}.status, '') NOT IN ('suspended', 'rejected')`;
}
