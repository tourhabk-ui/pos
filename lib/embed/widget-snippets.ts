/**
 * lib/embed/widget-snippets.ts — коды вставки виджетов Ведара для сайта
 * партнёра: чат с Кузьмичом (public/widget/embed.js) и кнопка заявки
 * (/api/widget/lead.js).
 *
 * Повод (аудит 15.10, находка WID-screens, W7): код знала только админка, и
 * только один — форму; кода чата не было нигде, а партнёр не видел ни того,
 * ни другого. Каждое включение шло через владельца и посредника. Теперь
 * экран кабинета оператора и карточка в админке берут ОБА кода отсюда, и
 * разойтись между собой не могут.
 *
 * Код собирается только из slug, который пропускает сам lead.js
 * (`^[\w-]+$`, до 100 знаков): иначе скрипт ответил бы «invalid partner slug»,
 * а в атрибут HTML попало бы что угодно. Не годится — null, и экран говорит
 * это словами, а не показывает нерабочий код.
 *
 * Модуль без серверных зависимостей: им пользуются экраны в браузере.
 */

/** Откуда грузятся скрипты: прод Ведара (так же их ищет перепись). */
export const WIDGET_SCRIPT_ORIGIN = 'https://vedarai.ru';

/** То же правило, что у /api/widget/lead.js: буквы, цифры, `_` и `-`. */
const SLUG_RE = /^[\w-]{1,100}$/;

export interface WidgetSnippets {
  /** Окно чата с Кузьмичом: туры только этого партнёра (WID-safety). */
  chat: string;
  /** Кнопка заявки: форма с телефоном и согласием на ПД. */
  form: string;
}

export function widgetSnippets(slug: string | null | undefined): WidgetSnippets | null {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  return {
    chat: `<script defer src="${WIDGET_SCRIPT_ORIGIN}/widget/embed.js" data-partner-id="${slug}"></script>`,
    form: `<script src="${WIDGET_SCRIPT_ORIGIN}/api/widget/lead.js?partner=${slug}" defer></script>`,
  };
}
