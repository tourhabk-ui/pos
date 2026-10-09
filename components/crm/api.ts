/**
 * Адреса API экрана CRM (CRM #2325). Режим решает, чьих клиентов видно:
 * партнёр — своих (`requirePartner`), администратор — всех и только для
 * чтения (`requireAdmin`). Других адресов у экрана нет — это держит сторож
 * crm-clients-screens.
 */
export const CRM_API = {
  partner: '/api/hub/crm/contacts',
  admin: '/api/admin/crm/contacts',
} as const;

export type CrmMode = keyof typeof CRM_API;

/**
 * Задачи (1в) — только партнёрские: задача — рабочая запись партнёра о своём
 * деле, администратору её не показывают, как и не дают править заметку.
 */
export const CRM_TASKS_API = '/api/hub/crm/tasks';
