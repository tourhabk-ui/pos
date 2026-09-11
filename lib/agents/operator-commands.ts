/**
 * Примеры команд оператора для экрана /hub/operator/ai-assist.
 *
 * Отдельный ЛИСТОВОЙ модуль намеренно: экран — клиентский компонент, а
 * `intent-classifier` тянет за собой `platform-agent` → `lib/ai/providers` →
 * `node:async_hooks`, и сборка для браузера падает (сторож
 * client-no-node-builtins поймал это в тот же прогон). Здесь только данные и
 * ТИП намерения — `import type` стирается при сборке.
 *
 * Живут рядом с ключевыми фразами по смыслу, а не по файлу: 11.09 кнопка
 * «Сводка туров» слала «Покажи сводку по моим турам», классификатор искал
 * «мои туры», не находил и отвечал 403 (#1800). Страница обещала команду,
 * которую сама же не умела разобрать. Сторож
 * tests/unit/ai-assist-examples.test.ts прогоняет каждый пример через
 * classifyIntentByKeywords и требует ожидаемое намерение.
 */
/**
 * Тип намерения объявлен ЗДЕСЬ строковым union, а не импортирован из
 * `platform-agent`: сторож client-no-node-builtins идёт по графу импортов, не
 * различая `import type`, и любая ссылка на тот модуль снова притащила бы
 * `node:async_hooks` в браузерную сборку. Совпадение с `AgentIntent`
 * проверяется на стороне сервера — в `intent-classifier` (присваивание типов)
 * и в tests/unit/ai-assist-examples.test.ts (прогон через классификатор).
 */
export type OperatorCommandIntent =
  | 'op_tours_summary'
  | 'op_bookings_today'
  | 'op_revenue'
  | 'op_create_tour'
  | 'op_fill_ai'
  | 'op_add_slots';

export const OPERATOR_COMMAND_EXAMPLES: Array<{
  label: string;
  message: string;
  intent: OperatorCommandIntent;
  group: 'read' | 'write';
}> = [
  { label: 'Сводка туров',        message: 'Покажи мои туры',                                              intent: 'op_tours_summary',  group: 'read' },
  { label: 'Бронирования сегодня', message: 'Бронирования сегодня',                                        intent: 'op_bookings_today', group: 'read' },
  { label: 'Выручка за 7 дней',   message: 'Выручка за последние 7 дней',                                  intent: 'op_revenue',        group: 'read' },
  { label: 'Создать тур',         message: 'Создай тур «Рыбалка на Авачинской бухте»',                     intent: 'op_create_tour',    group: 'write' },
  { label: 'AI заполнить тур',    message: 'Заполни тур 1',                                                intent: 'op_fill_ai',        group: 'write' },
  { label: 'Добавить слоты',      message: 'Добавь слоты туру 1 с 2026-07-01 по 2026-07-31, 10 мест',      intent: 'op_add_slots',      group: 'write' },
];
