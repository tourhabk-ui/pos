/**
 * Посты X для разведчика — с РАННЕРА GitHub (29.09).
 *
 * С прода Timeweb api.x.ai закрыт по региону: ai-debug run 13 получил на
 * запрос без ключа страницу «This service is not available in your region».
 * Владелец: «читался с гитхаба, с таймвеб геоблок». Поэтому поиск делает
 * раннер, а прод получает результат в теле запроса разведчика
 * (POST /api/cron/scout-digest, поле x_source) и сам в xAI не ходит.
 *
 * Функция поиска та же, что была на проде (lib/ai/xai-x-search, searchX) —
 * вторая реализация разошлась бы с первой. Скрипт только зовёт её и кладёт
 * результат в файл как есть: посты или отказ словами. Упасть он не должен —
 * исключение тоже становится отказом со словами, чтобы прод получил
 * причину, а не пустоту (§4.0).
 *
 * Расход в книги: logProviderPricedUsage на раннере уходит на прод через
 * usage-sink (нужен CRON_SECRET в env шага). Процесс не завершается
 * принудительно — отправка расхода успевает дойти.
 *
 * Запуск: npx tsx scripts/scout-x-fetch.ts /tmp/x-source.json
 */
import { writeFileSync } from 'node:fs';
import { searchX, type XSearchResult } from '@/lib/ai/xai-x-search';
import { X_HANDLES, X_SEARCH_WINDOW_HOURS } from '@/lib/agents/scout-sources';

async function main(): Promise<void> {
  const out = process.argv[2] ?? '/tmp/x-source.json';
  let result: XSearchResult;
  try {
    result = await searchX({ handles: X_HANDLES, hours: X_SEARCH_WINDOW_HOURS });
  } catch (e) {
    result = { ok: false, reason: `исключение на раннере: ${e instanceof Error ? e.message : String(e)}` };
  }
  writeFileSync(out, JSON.stringify(result));
  if (result.ok) {
    process.stdout.write(`X: ${result.posts.length} постов за ${X_SEARCH_WINDOW_HOURS} ч, модель ${result.model}, ${result.ms} мс\n`);
  } else {
    process.stdout.write(`X: отказ — ${result.reason}\n`);
  }
}

void main();
