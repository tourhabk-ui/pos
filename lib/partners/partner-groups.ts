/**
 * Разделение карточек партнёров на настоящих и потенциальных — один критерий
 * на админку («Операторы» и список партнёров в контенте).
 *
 * Партнёр — карточка, вошедшая в настоящий поток: заявка подана или уже
 * рассмотрена (`profile_status` <> 'none': pending/approved/rejected по CHECK
 * в lib/operator/profile-status.ts), либо есть строка заявки в
 * operator_applications (саморегистрация пишет её в той же транзакции, что
 * ставит 'pending', — app/api/auth/register-operator).
 *
 * Потенциальный — карточка, которая заявку не подавала: 'none' и заявки нет.
 * Такими заводятся импорт с visitkamchatka (external_source='visitkamchatka',
 * lib/services/ingest/*) и недозаполненные карточки. `external_source` как
 * критерий не годится: импортированная карточка после подачи заявки —
 * настоящий партнёр, а заведённая админом вручную получает 'pending' сразу
 * (app/api/admin/operators/create), то есть происхождение ≠ участие.
 *
 * Фрагменты рассчитаны на алиас таблицы `p` (partners p), как в обоих
 * админских роутах. EXISTS, а не JOIN: заявок у карточки может быть несколько,
 * и дублировать строки списка ради признака нельзя.
 */
export const PARTNER_GROUPS = ['partners', 'potential'] as const;
export type PartnerGroup = (typeof PARTNER_GROUPS)[number];

export function isPartnerGroup(v: unknown): v is PartnerGroup {
  return typeof v === 'string' && (PARTNER_GROUPS as readonly string[]).includes(v);
}

const HAS_APPLICATION = `EXISTS (SELECT 1 FROM operator_applications oa_g WHERE oa_g.partner_id = p.id)`;

export const PARTNER_GROUP_SQL: Record<PartnerGroup, string> = {
  partners: `(p.profile_status <> 'none' OR ${HAS_APPLICATION})`,
  potential: `(p.profile_status = 'none' AND NOT ${HAS_APPLICATION})`,
};

export const PARTNER_GROUP_LABELS: Record<PartnerGroup, string> = {
  partners: 'Партнёры',
  potential: 'Потенциальные',
};

/** Подпись-пояснение критерия для админских экранов: подпись обязана говорить, что считает. */
export const PARTNER_GROUP_HINTS: Record<PartnerGroup, string> = {
  partners: 'Подали заявку или уже в работе: на проверке, одобрены или отклонены.',
  potential: 'Карточки без заявки: импорт или недозаполненные, заявку не подавали.',
};
