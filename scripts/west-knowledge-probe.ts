/**
 * scripts/west-knowledge-probe.ts — как нас видят ChatGPT и Grok.
 *
 * Владелец 16.10: «как нас видят грок джипити чат». OpenAI и xAI с прода
 * закрыты гео-блоком, поэтому вопрос задаётся С РАННЕРА GitHub через
 * OpenRouter (секрет OPENROUTER_API_KEY репозитория). Логика, вопросы и
 * классификация — lib/ai/west-probe.ts; здесь только запуск и печать.
 *
 * Запуск: npx tsx scripts/west-knowledge-probe.ts [путь к маркеру]
 * (по умолчанию .github/triggers/west-knowledge-probe.json; поле "models"
 * маркера задаёт модели явно, иначе — сильнейшие из каталога OpenRouter).
 *
 * Печатает строку на каждую ногу, сводку в $GITHUB_STEP_SUMMARY (если задан)
 * и итоговый JSON. Код выхода 1 — только когда спросить не удалось НИ ОДНУ
 * модель ни одним вопросом: «не знает» — законный результат замера, а ноль
 * ответов на ненулевом входе — отказ (§4.0).
 *
 * Расход — в книги платформы через lib/ai/usage-sink (на раннере с
 * CRON_SECRET), agent_id 'west-knowledge-probe'. Плата OpenRouter за
 * веб-поиск в строки не входит: приёмник считает цену по токенам.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  formatLegLine,
  markerOverrides,
  renderWestSummary,
  runWestProbe,
  WEST_VENDORS,
  WEST_VENDOR_RULES,
} from '@/lib/ai/west-probe';
import { sendUsageToProd, usageSinkEnabled } from '@/lib/ai/usage-sink';

const DEFAULT_MARKER = '.github/triggers/west-knowledge-probe.json';

function readMarker(path: string): unknown {
  if (!existsSync(path)) {
    console.log(`маркер ${path} не найден — модели берутся из каталога OpenRouter`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (err) {
    // Сломанный маркер не останавливает замер, но молчать о нём нельзя:
    // модель, заданная в нём, тогда не применилась.
    console.error(`::warning::маркер ${path} не разобран как JSON (${err instanceof Error ? err.message : String(err)}) — модели берутся из каталога`);
    return null;
  }
}

async function main(): Promise<number> {
  const markerPath = process.argv[2] ?? DEFAULT_MARKER;
  const { overrides, problems } = markerOverrides(readMarker(markerPath));
  for (const p of problems) console.error(`::warning::${p}`);

  const report = await runWestProbe({
    fetchImpl: fetch,
    apiKey: process.env.OPENROUTER_API_KEY,
    overrides,
  });

  for (const vendor of WEST_VENDORS) {
    const m = report.models[vendor];
    console.log(m.model
      ? `${WEST_VENDOR_RULES[vendor].label}: ${m.model} (${m.source === 'override' ? 'из маркера' : 'из каталога'})${m.note ? ` — ${m.note}` : ''}`
      : `${WEST_VENDOR_RULES[vendor].label}: модели нет — ${m.reason ?? 'причина не названа'}`);
  }
  for (const leg of report.legs) {
    console.log(formatLegLine(leg));
    if (leg.outcome === 'could_not_ask') console.log(`::warning::${leg.vendor}/${leg.leg}: спросить не удалось — ${leg.reason ?? 'причина не названа'}`);
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, renderWestSummary(report));
    } catch (err) {
      console.error(`::warning::сводка в GITHUB_STEP_SUMMARY не записана: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Расход раннера — в книги (§8, 20.09). Не на раннере — не отправляется, и
  // это сказано; на раннере без секрета — громко: строки в книги не попадут.
  const tokens = report.usage_rows.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0);
  let usage: string;
  if (report.usage_rows.length === 0) {
    usage = 'ни один ответ не назвал токены — отправлять в книги нечего';
  } else if (usageSinkEnabled()) {
    const sent = await sendUsageToProd(report.usage_rows);
    usage = sent
      ? `строк расхода в книги: ${report.usage_rows.length} (${tokens} токенов)`
      : `расход НЕ записан в книги: прод не принял ${report.usage_rows.length} строк — причина выше`;
    if (!sent) console.error(`::warning::${usage}`);
  } else if (process.env.GITHUB_ACTIONS === 'true') {
    usage = `расход НЕ записан в книги: на раннере нет CRON_SECRET (${report.usage_rows.length} строк, ${tokens} токенов)`;
    console.error(`::warning::${usage}`);
  } else {
    usage = `запуск не на раннере — расход в книги не отправлялся (${report.usage_rows.length} строк, ${tokens} токенов)`;
  }
  console.log(usage);
  console.log('Плата OpenRouter за веб-поиск в строки книг не входит: приёмник считает цену по токенам.');

  console.log(JSON.stringify({ ...report, usage_books: usage }, null, 2));
  if (report.exit_code !== 0) console.error(`::error::${report.error ?? 'замера нет'}`);
  return report.exit_code;
}

// Запуск только как скрипт: при импорте из теста main не вызывается.
if (process.argv[1] && process.argv[1].endsWith('west-knowledge-probe.ts')) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
