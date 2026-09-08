/**
 * AI Agent Permission Model
 * Defines which intents each role can call.
 */

export type AgentRole = 'admin' | 'operator' | 'guide' | 'tourist' | 'anonymous';

/**
 * Что каждая роль вправе запросить.
 *
 * ── Почему список обязан покрывать маршрутизатор (находка аудита 08.09) ─────
 *
 * До 08.09 `canDispatchIntent` не вызывался ни разу: матрица была украшением,
 * доходило что угодно. Гейт поставили — и стало видно, что матрица никогда не
 * сверялась с `route()`. Из двадцати двух веток маршрутизатора двенадцать не
 * мог достать никто, кроме админа с его звёздочкой, и пять из них — своё
 * агентство гида, включая `guide_route_preflight`: проверку маршрута перед
 * выходом, то есть ровно ту функцию, ради которой платформа существует.
 *
 * Живой аварии это не вызвало, и врать тут не нужно: `dispatch` сегодня зовут
 * только с ролями `admin` и `operator`, а функции гида живут обычными роутами
 * мимо агента. Но скрытое расхождение стало ЗАКРЕПЛЁННЫМ — кто заведёт путь
 * гида завтра, получил бы тихий `unknown` вместо ответа, и искал бы причину
 * в классификаторе, а не здесь.
 */
const ROLE_INTENTS: Record<AgentRole, string[]> = {
  admin: ['*'], // admin can call anything

  operator: [
    'op_tours_summary',
    'op_bookings_today',
    'op_revenue',
    'op_create_tour',
    'op_fill_ai',
    'op_add_slots',
  ],

  guide: [
    // Своё агентство (lib/agents/agencies/guide-agency.ts).
    'guide_schedule',
    'guide_groups',
    'guide_earnings',
    'guide_status',
    'guide_route_preflight',
    // Обстановка в поле: гид ведёт людей и обязан видеть её сам.
    'rescue_sos_stats',
    'rescue_weather_risk',
    'rescue_protocols',
  ],

  tourist: [
    'tourist_recommend',
  ],

  anonymous: [],
};

/**
 * Интенты, у которых нет и не должно быть неадминской роли.
 *
 * Не «забыли выдать», а решение владельца: публикация в канал, маркетинг и
 * разбор лидов — его работа. Список назван явно, чтобы сторож мёртвых веток
 * отличал сознательное от упущенного; молчание этих двух вещей не различает.
 */
export const ADMIN_ONLY_INTENTS: readonly string[] = [
  'admin_digest', 'admin_health', 'admin_leads',
  'lead_qualify', 'lead_suggest',
  'channel_post_route', 'channel_post_tip', 'channel_post_sezon', 'channel_audit',
  'mkt_performance', 'mkt_content_plan',
];

/** Все роли, кроме админа: у него звёздочка, и проверка им бессмысленна. */
export const NON_ADMIN_ROLES: readonly AgentRole[] = [
  'operator', 'guide', 'tourist', 'anonymous',
];

export function canDispatchIntent(role: string | undefined | null, intent: string): boolean {
  const r = (role ?? 'anonymous') as AgentRole;
  const allowed = ROLE_INTENTS[r] ?? [];
  return allowed.includes('*') || allowed.includes(intent);
}

export function allowedIntentsForRole(role: string): string[] {
  const r = (role ?? 'anonymous') as AgentRole;
  return ROLE_INTENTS[r] ?? [];
}
