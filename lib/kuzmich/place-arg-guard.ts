/**
 * Вулкан в аргументе инструмента — тот, о котором говорит человек (пробы 764 и
 * 765, 13.10, через журнал общения A2A).
 *
 * На вопрос «какая сейчас обстановка у Авачинского вулкана?» Кузьмич дважды
 * ответил про чужой вулкан: в первый раз про Ключевской, во второй — про
 * Мутновский. Ровно эти два имени стояли примером в описании параметра
 * get_volcano_status («например „Ключевской“ или „Мутновский“»). Модель
 * подставила в вызов ПРИМЕР ИЗ ОПИСАНИЯ, инструмент честно вернул данные по
 * чужому вулкану, и уверенный ответ с настоящими цифрами ушёл не про то место.
 * Сторож заземления такого не видит: данные пришли из инструмента.
 *
 * Обе пробы прошли в утреннее окно пика DeepSeek (06:00–10:00 UTC по будням,
 * lib/ai/deepseek-peak): DeepSeek не укладывается в таймаут, и инструменты
 * зовёт запасная модель — она-то и копирует примеры. Отсюда «периодически»:
 * качество падает по часам, когда отвечает не та модель.
 *
 * Описания параметров примеров с названиями больше не содержат
 * (lib/kuzmich/tool-schemas). Сторож — второй слой, детерминированный, по
 * правилу §8 («не правилами в промпте, а сервером»):
 *
 *  · вулкан в аргументе назван и в разговоре тоже — ничего не трогаем;
 *  · вулкан в аргументе, которого в разговоре нет, а в разговоре назван
 *    ровно один другой — подставляем названный;
 *  · в разговоре названо несколько — не угадываем: инструмент не исполняется,
 *    модель получает просьбу вызвать его по каждому названному;
 *  · в разговоре вулкан не назван вовсе («вулкан у Петропавловска») — модель
 *    вправе вывести его сама, аргумент не трогаем.
 *
 * Распознавание имени — namedVolcanoes (lib/ai/tour-place-relevance): тот же
 * справочник KVERT и та же основа, что сопоставляют коды вулканов с местами.
 *
 * Модуль чистый. Сторож: tests/unit/kuzmich-place-arg-guard.test.ts.
 */

import { namedVolcanoes } from '@/lib/ai/tour-place-relevance';

/** Инструменты Кузьмича и их параметры, куда модель кладёт название места. */
export const PLACE_ARGS: Readonly<Record<string, readonly string[]>> = {
  get_volcano_status: ['volcano'],
  get_weather: ['place'],
  get_guardian_context: ['place'],
  get_place_info: ['name'],
  search_transfers: ['place'],
};

export type PlaceArgDecision =
  | { kind: 'keep' }
  | { kind: 'rebind'; args: Record<string, string>; from: string; to: string }
  | { kind: 'ask'; message: string };

export function guardPlaceArgs(
  toolName: string,
  args: Record<string, string>,
  conversation: string,
): PlaceArgDecision {
  const keys = PLACE_ARGS[toolName];
  if (!keys) return { kind: 'keep' };
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const inArg = namedVolcanoes(value);
    if (inArg.length === 0) continue;
    const said = namedVolcanoes(conversation);
    if (said.length === 0 || inArg.every((v) => said.includes(v))) continue;
    if (said.length === 1) {
      return { kind: 'rebind', args: { ...args, [key]: said[0]! }, from: value, to: said[0]! };
    }
    return {
      kind: 'ask',
      message: `Вулкана «${value}» в разговоре нет, а названы: ${said.map((v) => `«${v}»`).join(', ')}. `
        + `Вызови ${toolName} для каждого названного, а не для другого вулкана.`,
    };
  }
  return { kind: 'keep' };
}
