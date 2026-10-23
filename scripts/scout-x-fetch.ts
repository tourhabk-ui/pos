/**
 * Посты X для разведчика — с РАННЕРА GitHub (29.09).
 *
 * С прода Timeweb api.x.ai закрыт по региону: ai-debug run 13 получил на
 * запрос без ключа страницу «This service is not available in your region».
 * Владелец: «читался с гитхаба, с таймвеб геоблок». Поэтому чтение делает
 * раннер, а прод получает результат в теле запроса разведчика
 * (POST /api/cron/scout-digest, поле x_source) и сам в X не ходит.
 *
 * С 23.10 посты читаются напрямую через X API ключом владельца, xAI
 * `x_search` — запасной путь; выбор — lib/x/scout-x-read (правило под
 * тестом, вторая реализация разошлась бы с первой). Скрипт только зовёт его
 * и кладёт результат в файл как есть: посты или отказ словами. Упасть он не
 * должен — исключение тоже становится отказом со словами, чтобы прод получил
 * причину, а не пустоту (§4.0).
 *
 * Расход xAI в книги: logProviderPricedUsage на раннере уходит на прод через
 * usage-sink (нужен CRON_SECRET в env шага). У X API цены за вызов нет —
 * в книги он не пишет, остаток лимита печатается в лог. Процесс не
 * завершается принудительно — отправка расхода успевает дойти.
 *
 * Запуск: npx tsx scripts/scout-x-fetch.ts /tmp/x-source.json
 */
import { writeFileSync } from 'node:fs';
import type { XSearchResult } from '@/lib/ai/xai-x-search';
import { X_HANDLES, X_SEARCH_WINDOW_HOURS } from '@/lib/agents/scout-sources';
import { readXForScout } from '@/lib/x/scout-x-read';

async function main(): Promise<void> {
  const out = process.argv[2] ?? '/tmp/x-source.json';
  let result: XSearchResult;
  try {
    result = await readXForScout({ handles: X_HANDLES, hours: X_SEARCH_WINDOW_HOURS });
  } catch (e) {
    result = { ok: false, reason: `исключение на раннере: ${e instanceof Error ? e.message : String(e)}` };
  }
  writeFileSync(out, JSON.stringify(result));
  if (result.ok) {
    process.stdout.write(`X: ${result.posts.length} постов за ${X_SEARCH_WINDOW_HOURS} ч, путь ${result.model}, ${result.ms} мс\n`);
    // Ноль постов — с формой ответа (30.09): иначе «никто не писал» и «модель
    // не искала» неотличимы.
    const d = result.diag;
    if (d) {
      if (d.credentialsFrom) process.stdout.write(`X: ключ из ${d.credentialsFrom}\n`);
      if (d.fallbackFrom) process.stdout.write(`X: запасной путь xAI, потому что ${d.fallbackFrom}\n`);
      process.stdout.write(`X: запросов ${d.requests}, вызовов поиска ${d.searchCalls}\n`);
      if (d.rateLimit) process.stdout.write(`X: остаток лимита ${d.rateLimit.remaining}${d.rateLimit.resetAt ? `, окно до ${d.rateLimit.resetAt}` : ''}\n`);
      if (d.truncated) process.stdout.write('X: за окно больше ста постов — показаны не все\n');
      if (d.chunkErrors) process.stdout.write(`X: отказы частей — ${d.chunkErrors.join(' | ')}\n`);
      if (d.emptyAnswerHead !== undefined) process.stdout.write(`X: начало ответа — ${d.emptyAnswerHead}\n`);
    }
  } else {
    process.stdout.write(`X: отказ — ${result.reason}\n`);
  }
}

void main();
