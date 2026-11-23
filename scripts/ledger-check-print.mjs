/**
 * Печать ответа /api/cron/safety-ledger-check в лог GitHub Actions.
 *
 * Лог публичный. В ответе — последние строки журнала решений безопасности:
 * у записи человека (`actor_type: editor`) есть автор и причина, написанная
 * словами. Сегодня там фиксированные фразы, но колонка причины — свободный
 * текст, и первый писатель, положивший туда слова человека, опубликовал бы
 * их без единого сигнала. Поэтому автор и причина печатаются только у
 * машинных записей (`system`, `source`); у остальных — скрыты, событие и
 * время остаются. Неизвестный род автора считается человеком.
 *
 * Строки лежат в `recent` обёрткой `{ ok, value: [...] }` (исход пробы в
 * роуте), а не списком. Первая редакция этой чистки (23.11) шла по `recent`
 * как по списку, перебирала ключи обёртки и не скрывала ничего — поэтому
 * чистка живёт здесь, а не в теле workflow, и проверяется запуском на обеих
 * формах (tests/unit/cron-body-summary.test.ts).
 *
 * Запуск: node scripts/ledger-check-print.mjs <файл ответа>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MACHINE_ACTORS = new Set(['system', 'source']);

/** Строки журнала из ответа: обёртка пробы либо сам список. */
function recentRows(body) {
  const recent = body && typeof body === 'object' ? body.recent : null;
  if (Array.isArray(recent)) return recent;
  if (recent && typeof recent === 'object' && Array.isArray(recent.value)) return recent.value;
  return [];
}

/** Скрывает автора и причину у записей человека; возвращает число таких записей. */
export function redactLedger(body) {
  let hidden = 0;
  for (const row of recentRows(body)) {
    if (!row || typeof row !== 'object') continue;
    if (MACHINE_ACTORS.has(row.actor_type)) continue;
    const reason = typeof row.decision_reason === 'string' ? row.decision_reason : '';
    row.actor_id = '(скрыто)';
    row.decision_reason = `(скрыто, ${reason.length} зн.)`;
    hidden++;
  }
  return hidden;
}

function main() {
  const file = process.argv[2];
  let body;
  try {
    body = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log('::error::Ответ проверки журнала не разобран — печатать нечего');
    return 1;
  }
  // Вердикт словами — первым, чтобы читающий не разбирал JSON ради него.
  console.log('ВЕРДИКТ:', body && typeof body === 'object' && body.verdict ? body.verdict : '(нет)');
  console.log('');
  const hidden = redactLedger(body);
  console.log(JSON.stringify(body, null, 2));
  if (hidden > 0) console.log(`\nАвтор и причина скрыты у записей человека: ${hidden}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main());
