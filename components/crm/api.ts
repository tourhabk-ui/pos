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

/**
 * Выгрузка клиентов в CSV (1а-2b) — те же фильтры, что у списка партнёра.
 * Только партнёрская: администратор клиентов не выгружает.
 */
export const CRM_EXPORT_API = '/api/hub/crm/contacts/export';

/** «Входящие» (1г) — только партнёрские: что ждёт ответа у вошедшего партнёра. */
export const CRM_INBOX_API = '/api/hub/crm/inbox';
