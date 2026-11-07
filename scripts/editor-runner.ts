/**
 * scripts/editor-runner.ts — описания пишет РАННЕР, а не прод.
 *
 * Повод (решение владельца 07.09: «OpenRouter переключи на гитхаб»): с прода
 * OpenRouter отвечает 403 и напрямую, и через релей — ответы совпали дословно,
 * значит режет край сети по нашему адресу, и релей его не прячет. Флагманы
 * оттуда недостижимы, поэтому `callAIQuality` намеренно ставит первым DeepSeek.
 *
 * Раннер GitHub не в РФ и OpenRouter достигает. Тот же приём, что у разбора
 * находок и AI-ревью Growth Scan.
 *
 * Разделение труда: список записей и запись результата — за продом (базу видит
 * только он), модель — за раннером. Промпт и разбор ответа общие с прод-путём
 * (`buildDescriptionMessages`, `pickDescriptionFromAnswer`): две копии правил
 * разошлись бы, и половина описаний оказалась бы написана по другим законам.
 *
 * Расход (07.11) — в книги `llm_usage_log` под подписью «editor-runner»: модель
 * зовётся своим fetch, мимо `logLLMUsage`, и до этого дня ни один её ответ не
 * попадал в книги — ни на вкладку «Деньги», ни в дневной бюджет. Строки уходят
 * на прод через usage-sink (`CRON_SECRET` в env шага), цену считает сервер.
 *
 * Использование: npx tsx scripts/editor-runner.ts <job.json> <result.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { openRouterAttribution } from '../lib/ai/attribution';
import { sendUsageToProd, usageRowFromResponse, type UsageRowToReport } from '../lib/ai/usage-sink';
import {
  EDITOR_TEMPERATURE,
  buildDescriptionMessages,
  pickDescriptionFromAnswer,
  type RouteRow,
} from '../lib/agents/editor';

/** Потолок прогона: раннеру дано 15 минут, оставляем запас на публикацию. */
const TIME_BUDGET_MS = 10 * 60 * 1000;
/** Подпись в книгах расхода — та же, что у журнала прогонов раннера. */
const AGENT_ID = 'editor-runner';
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

interface Job { routes?: RouteRow[]; queue_total?: number }

interface ResultItem { id: string; title: string; description?: string; skipped?: string; declined?: boolean }

async function askOpenRouter(
  messages: Array<{ role: string; content: string }>,
  key: string,
  model: string,
): Promise<{ text: string | null; error: string | null; usage: UsageRowToReport | null; answered: boolean }> {
  try {
    const res = await fetch(OPENROUTER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${key}`,
        ...openRouterAttribution('editor'),
      },
      // Температура — та же, что у прод-пути: строгий пересказ, не варианты (23.10).
      body: JSON.stringify({ model, messages, max_tokens: 1600, temperature: EDITOR_TEMPERATURE }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = await res.text();
      return { text: null, error: `HTTP ${res.status}: ${body.slice(0, 200)}`, usage: null, answered: false };
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? null;
    // Ответ оплачен, даже если текст потом отвергнут разбором, — строка в книги
    // идёт при любом тексте.
    const usage = usageRowFromResponse(data, model, AGENT_ID);
    return { text, error: text ? null : 'ответ без содержимого', usage, answered: true };
  } catch (err) {
    return { text: null, error: err instanceof Error ? err.message : String(err), usage: null, answered: false };
  }
}

async function main(): Promise<void> {
  const [jobPath, outPath] = process.argv.slice(2);
  if (!jobPath || !outPath) {
    console.error('Использование: editor-runner.ts <job.json> <result.json>');
    process.exit(2);
  }

  const key = (process.env.OPENROUTER_API_KEY ?? '').trim();
  const model = (process.env.EDITOR_RUNNER_MODEL ?? 'anthropic/claude-opus-5').trim();

  const job = JSON.parse(readFileSync(jobPath, 'utf8')) as Job;
  const routes = job.routes ?? [];

  const items: ResultItem[] = [];
  let asked = 0;
  let firstError: string | null = null;
  const usageRows: UsageRowToReport[] = [];
  let usageMissing = 0;

  // Ключа нет — это НЕ «описаний не нашлось». Пишем причину и выходим с
  // отказом: тишина здесь неотличима от чистого прогона (§4.0).
  if (!key) {
    writeFileSync(outPath, JSON.stringify({
      model: null, asked: 0, items: [],
      error: 'OPENROUTER_API_KEY не задан на раннере — модель не звалась ни разу',
    }, null, 2));
    console.error('OPENROUTER_API_KEY не задан.');
    process.exit(1);
  }

  const start = Date.now();
  for (const route of routes) {
    if (Date.now() - start > TIME_BUDGET_MS) {
      console.log(`бюджет времени исчерпан — обработано ${asked}/${routes.length}`);
      break;
    }
    const messages = buildDescriptionMessages(route).map(({ role, content }) => ({ role, content }));
    const { text, error, usage, answered } = await askOpenRouter(messages, key, model);
    asked += 1;
    if (usage) usageRows.push(usage);
    else if (answered) usageMissing += 1;

    if (error) {
      firstError ??= error;
      items.push({ id: route.id, title: route.title, skipped: error.slice(0, 200) });
      continue;
    }
    const outcome = pickDescriptionFromAnswer(text);
    if (!outcome.text) {
      // «НЕТ» — модель сказала, что из фактов нечего написать: исход, а не
      // провал (23.10). Считается отдельно, чтобы ноль описаний при честных
      // отказах не выглядел поломкой.
      items.push({
        id: route.id, title: route.title,
        skipped: outcome.failReason ?? 'разбор не дал текста',
        ...(outcome.noSource ? { declined: true } : {}),
      });
      continue;
    }
    items.push({ id: route.id, title: route.title, description: outcome.text });
  }

  const written = items.filter((i) => i.description).length;
  const declined = items.filter((i) => i.declined).length;
  const errored = items.filter((i) => !i.description && !i.declined).length;
  // Ноль описаний при одних честных «НЕТ» — исход «фактов мало», а не поломка.
  // Ноль описаний, где хоть одна запись упала на провайдере или разборе, —
  // отказ (§4.0): одно «НЕТ» не прячет одиннадцать ответов 429.
  const failed = written === 0 && (declined === 0 || errored > 0);

  // Расход — в книги до записи результата: публикация описаний от него не
  // зависит, но и молча не теряет. Отказ отправки назван в логе и в итоге.
  const usageReported = usageRows.length > 0 ? await sendUsageToProd(usageRows) : null;
  console.log(
    `расход в книги: строк ${usageRows.length}` +
    (usageMissing > 0 ? `; ответов без usage ${usageMissing} — их расход неизвестен` : '') +
    (usageReported === null ? '' : usageReported ? '; прод принял' : '; прод НЕ принял (причина выше)'),
  );

  writeFileSync(outPath, JSON.stringify({
    model, asked, written, declined, errored, queue_total: job.queue_total ?? null,
    usage: { rows: usageRows.length, missing: usageMissing, reported: usageReported },
    error: failed ? (firstError ?? 'ни одного описания не получено') : null,
    items,
  }, null, 2));

  console.log(`модель: ${model}; запрошено: ${asked}; описаний получено: ${written}; «нечего написать»: ${declined}; сбоев: ${errored}`);
  if (routes.length > 0 && failed) {
    console.error(`Ни одного описания. Первая причина: ${firstError ?? 'не записана'}`);
    process.exit(1);
  }
}

void main();
