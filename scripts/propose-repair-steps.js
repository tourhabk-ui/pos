/**
 * scripts/propose-repair-steps.js
 *
 * Петля самоулучшения ремонта данных (решение владельца 2026-07-18):
 * прогон data-repair сам анализирует свои результаты и ПРЕДЛАГАЕТ новые
 * правила — GitHub issue с драфтом. Коммит правила — по-прежнему человек
 * + CI: скрипт ничего не меняет ни в БД, ни в коде.
 *
 * Вход: apply.json (итоги боевого прогона) + inv.json (инвентаризация).
 * Выход (stdout): markdown-предложение с сигнатурой содержимого
 * (<!-- sig:... -->) для дедупликации issues. Пусто — если предлагать нечего.
 *
 * Паттерны v1 (принципы, не перечни):
 *  1. Маршрут с >=3 дальними waypoints — вероятная обзорная статья с
 *     мусорными связками (прецедент: «Рыболовная база», миграция 754).
 *  2. Пары разноимённых мест ровно друг на друге (<= 50 м) — след
 *     геокодера-заглушки, у которого не нашлось трека-тёзки (Шаг 1b мимо):
 *     нужен внешний источник или сверка владельцем (прецедент: 751-752).
 *  3. Места, скрытые как «координата не восстановилась», — ждут координат
 *     владельца (прецедент: рыболовная база, миграция 756).
 */

const crypto = require('crypto');
const fs = require('fs');

/** Разбор route-названия из detail wp_outlier: «NN км от маршрута «X» — …» */
function outlierRoute(detail) {
  const m = /от маршрута «([^»]+)»/.exec(detail ?? '');
  return m ? m[1] : null;
}

function buildProposal(apply, inv) {
  const items = Array.isArray(apply?.items) ? apply.items : [];
  const sections = Array.isArray(inv?.sections) ? inv.sections : [];

  // 1. Маршруты с >=3 wp_outlier связками
  const perRoute = new Map();
  for (const it of items) {
    if (it.step !== 'wp_outlier') continue;
    const route = outlierRoute(it.detail);
    if (!route) continue;
    const arr = perRoute.get(route) ?? [];
    arr.push(`${it.place ?? '?'} — ${it.detail}`);
    perRoute.set(route, arr);
  }
  const junkRoutes = [...perRoute.entries()].filter(([, rows]) => rows.length >= 3);

  // 2. Пары ровно друг на друге (<= ~50 м)
  const dupeSection = sections.find(s => s.id === 'places_coord_dupes');
  const stackedPairs = (dupeSection?.rows ?? []).filter(r => Number(r.km) <= 0.05);

  // 3. Скрытые без координат
  const hiddenNoCoords = items
    .filter(it => it.step === 'coords' && /скрыто до ручной/.test(it.detail ?? ''))
    .map(it => it.place)
    .filter(Boolean);

  if (junkRoutes.length === 0 && stackedPairs.length === 0 && hiddenNoCoords.length === 0) {
    return null;
  }

  const lines = [];
  lines.push('Автоанализ прогона ремонта данных нашёл паттерны, для которых нет автоматического шага. Это ПРЕДЛОЖЕНИЯ: решение и коммит — за человеком.');
  lines.push('');
  if (junkRoutes.length > 0) {
    lines.push('## 1. Маршруты с 3+ дальними waypoints — кандидаты на чистку связок');
    lines.push('Прецедент: «Рыболовная база «Камчатская Рыбалка»» (миграция 754). Драфт правила: DELETE FROM route_waypoints для перечисленных маршрутов после ручного подтверждения, либо скрытие маршрута как статьи.');
    lines.push('');
    for (const [route, rows] of junkRoutes) {
      lines.push(`- **«${route}»** — ${rows.length} дальних связок:`);
      for (const r of rows.slice(0, 5)) lines.push(`  - ${r}`);
      if (rows.length > 5) lines.push(`  - …и ещё ${rows.length - 5}`);
    }
    lines.push('');
  }
  if (stackedPairs.length > 0) {
    lines.push('## 2. Разноимённые места друг на друге (<= 50 м) — нет трека-тёзки');
    lines.push('Шаг 1b их не берёт (нет донора). Драфт: миграция с верифицированными координатами (прецедент 751-752) — нужны источники или сверка владельцем (Яндекс/2ГИС-ссылка).');
    lines.push('');
    for (const p of stackedPairs) {
      lines.push(`- «${p.name_a}» ↔ «${p.name_b}» (${p.km} км)`);
    }
    lines.push('');
  }
  if (hiddenNoCoords.length > 0) {
    lines.push('## 3. Скрыты без координат — ждут точку от владельца');
    lines.push('Прецедент: рыболовная база (миграция 756, ссылка Яндекс.Карт от владельца).');
    lines.push('');
    for (const name of hiddenNoCoords) lines.push(`- ${name}`);
    lines.push('');
  }

  const body = lines.join('\n');
  const sig = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `${body}\n<!-- sig:${sig} -->\n`;
}

module.exports = { buildProposal, outlierRoute };

if (require.main === module) {
  const [applyPath, invPath] = process.argv.slice(2);
  let apply = {};
  let inv = {};
  try { apply = JSON.parse(fs.readFileSync(applyPath, 'utf8')); } catch { /* нет файла — пустой вход */ }
  try { inv = JSON.parse(fs.readFileSync(invPath, 'utf8')); } catch { /* нет файла — пустой вход */ }
  const proposal = buildProposal(apply, inv);
  if (proposal) process.stdout.write(proposal);
}
