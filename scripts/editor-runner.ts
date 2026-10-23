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
 * Использование: npx tsx scripts/editor-runner.ts <job.json> <result.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { openRouterAttribution } from '../lib/ai/attribution';
import {
  EDITOR_TEMPERATURE,
  buildDescriptionMessages,
  pickDescriptionFromAnswer,
  type RouteRow,
} from '../lib/agents/editor';

/** Потолок прогона: раннеру дано 15 минут, оставляем запас на публикацию. */
const TIME_BUDGET_MS = 10 * 60 * 1000;
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

interface Job { routes?: RouteRow[]; queue_total?: number }

interface ResultItem { id: string; title: string; description?: string; skipped?: string; declined?: boolean }

async function askOpenRouter(
  messages: Array<{ role: string; content: string }>,
  key: string,
  model: string,
): Promise<{ text: string | null; error: string | null }> {
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
      return { text: null, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? null;
    return { text, error: text ? null : 'ответ без содержимого' };
  } catch (err) {
    return { text: null, error: err instanceof Error ? err.message : String(err) };
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
    const { text, error } = await askOpenRouter(messages, key, model);
    asked += 1;

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
  // Ноль описаний при честных «НЕТ» — исход «фактов мало», а не поломка; ноль
  // описаний без единого ответа модели — отказ (§4.0).
  const failed = written === 0 && declined === 0;
  writeFileSync(outPath, JSON.stringify({
    model, asked, written, declined, queue_total: job.queue_total ?? null,
    error: failed ? (firstError ?? 'ни одного описания не получено') : null,
    items,
  }, null, 2));

  console.log(`модель: ${model}; запрошено: ${asked}; описаний получено: ${written}; «нечего написать»: ${declined}`);
  if (routes.length > 0 && failed) {
    console.error(`Ни одного описания. Первая причина: ${firstError ?? 'не записана'}`);
    process.exit(1);
  }
}

void main();
