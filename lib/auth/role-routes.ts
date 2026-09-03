/**
 * Единая карта «роль → кабинет».
 * Используется гардом HubLayout и редиректами после логина/регистрации —
 * раньше карта дублировалась в трёх местах и расходилась (stay/gear
 * не знали своего кабинета).
 */
export const ROLE_HUB: Record<string, string> = {
  tourist:           '/hub/tourist',
  operator:          '/hub/operator',
  guide:             '/hub/guide',
  // Кабинет перевозчика на схеме 926 (02.09). Прежний /hub/transfer-operator
  // удалён вместе с мёртвым модулем; до этой строки роль вела на 404.
  transfer:          '/hub/carrier',
  transfer_operator: '/hub/carrier',
  agent:             '/hub/agent',
  gear:              '/hub/gear',
  stay:              '/hub/stay',
  admin:             '/hub/admin',
};

/** Роли, которым при регистрации создаётся партнёрский профиль (partners.category). */
export const PARTNER_ROLES = ['operator', 'guide', 'transfer', 'agent', 'stay', 'gear'] as const;
