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
  transfer:          '/hub/transfer-operator',
  transfer_operator: '/hub/transfer-operator',
  agent:             '/hub/agent',
  gear:              '/hub/gear',
  stay:              '/hub/stay',
  admin:             '/hub/admin',
};

/** Роли, которым при регистрации создаётся партнёрский профиль (partners.category). */
export const PARTNER_ROLES = ['operator', 'guide', 'transfer', 'agent', 'stay', 'gear'] as const;
