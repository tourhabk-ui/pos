/**
 * lib/crm/event-kinds.ts — словарь ленты (CRM #2325): виды событий, кто их
 * совершает, подписи. Без пула и без сервера — это читают и роуты, и
 * клиентские компоненты. Виды — ровно те, у которых есть производитель
 * (правило 10.09); сторож сверяет список с CHECK миграции и с кодом.
 */

export const EVENT_KINDS = ['status_change', 'change', 'note', 'call', 'meeting', 'message_in', 'message_out'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Касания руками партнёра — с экрана, из Кузьмича, из MCP. */
export const TOUCH_KINDS = ['note', 'call', 'meeting'] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

export const ACTOR_KINDS = ['partner_user', 'tourist', 'system', 'kuzmich', 'mcp', 'admin'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const EVENT_KIND_LABELS: Readonly<Record<EventKind, string>> = {
  status_change: 'Смена статуса',
  change: 'Изменение',
  note: 'Заметка',
  call: 'Звонок',
  meeting: 'Встреча',
  message_in: 'Сообщение от клиента',
  message_out: 'Сообщение клиенту',
};

export const ACTOR_KIND_LABELS: Readonly<Record<ActorKind, string>> = {
  partner_user: 'партнёр',
  tourist: 'турист',
  system: 'платформа',
  kuzmich: 'Кузьмич',
  mcp: 'агент партнёра',
  admin: 'администратор',
};

export const TITLE_MAX = 300;
export const DETAILS_MAX = 5000;
