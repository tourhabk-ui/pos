/**
 * POST /api/admin/llm-usage/report
 *
 * Приём расхода LLM, потраченного НЕ на проде.
 *
 * Зачем (19.09, владелец: «ANTHROPIC_API_KEY закончился баланс, при чем что то
 * очень быстро»). Судья эволюции и AI-ревью Growth Scan считают на раннере
 * GitHub (§8: «раннер GitHub — секреты репозитория»), и это два самых дорогих
 * потребителя платформы. `logLLMUsage` пишет их строки прямым INSERT в
 * `llm_usage_log` — но `DATABASE_URL` в `evo-judge.yml` и `evo-review.yml нет`,
 * и БД Timeweb с раннера закрыта файрволом (тот же барьер, из-за которого
 * дорожный граф принимает ЭТОТ каталог, а не строится на проде). То есть INSERT
 * падал всегда, `console.error` уходил в лог прогона, который никто не читает,
 * и в книгах расхода не оставалось НИ ОДНОЙ строки.
 *
 * Следствие было не «неточный отчёт», а «бюджет не видит самого дорогого»:
 * `/api/cron/llm-budget-check` суммирует `llm_usage_log`, значит по тратам
 * раннера он не мог сработать ни при каком `AI_DAILY_BUDGET_USD`.
 *
 * Тот же приём, что у `POST /api/admin/import/road-graph`: раннер делает то,
 * чего не может прод, прод — то, чего не может раннер. Auth — `CRON_SECRET`
 * (Bearer): зовёт workflow, не человек. Edge-гейт `/api/admin/*` эту форму
 * авторизации уже принимает (§7, решение владельца 01.09).
 *
 * ЦЕНУ СЧИТАЕТ СЕРВЕР, а не присылает клиент. Иначе строка в книгах была бы
 * утверждением звонящего о собственных расходах — а книги для того и нужны,
 * чтобы такие утверждения проверять. Клиент присылает только то, что знает
 * провайдер: имя модели и токены.
 *
 * Кэш подсказок (аудит 15.10, AC-1). «Руки» — claude-code-action — шлют сюда
 * ещё и запись в кэш и чтение из него: по разбору счёта (CLAUDE.md §5.1) кэш —
 * 70% денег Anthropic, и без него книги занизили бы расход рук в разы. Оба
 * поля необязательны: прежние звонящие их не шлют, и их строки считаются как
 * раньше, а колонки кэша остаются NULL — «не сообщали», не ноль. Цену кэша
 * считает тоже сервер: множители вендора — `lib/ai/cache-pricing.ts`.
 * `total_tokens` по-прежнему вход + выход (смысл колонки с миграции 686), кэш
 * лежит в своих колонках (миграция 1286).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { resolveCostUsd } from '@/lib/ai/providers';
import { inputEquivalentTokens } from '@/lib/ai/cache-pricing';

export const dynamic = 'force-dynamic';

const UsageRow = z.object({
  /** Ключ журнала — ровно тот, что пишет logLLMUsage (может быть `vendor:model`). */
  model: z.string().min(1).max(200),
  prompt_tokens: z.number().int().min(0).max(50_000_000),
  completion_tokens: z.number().int().min(0).max(50_000_000),
  /**
   * Кэш подсказок (руки, аудит 15.10 AC-1). Необязательны: нет поля или null —
   * источник не сообщил, в книгах NULL. Потолок шире, чем у входа: прогон руки
   * перечитывает свой контекст на каждом ходу, и чтение кэша за прогон — это
   * миллионы токенов. Верх — в пределах INTEGER колонки.
   */
  cache_creation_tokens: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  cache_read_tokens: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  /** Кто потратил: `evo-judge`, `evo-review`, руки — имя своего workflow. Не знаем — null, не выдумка. */
  agent_id: z.string().min(1).max(100).nullable().optional(),
});

const BodySchema = z.object({
  rows: z.array(UsageRow).min(1).max(200),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(req), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof z.ZodError ? e.issues[0]?.message : 'Некорректное тело запроса' },
      { status: 400 },
    );
  }

  let written = 0;
  let unknownCost = 0;
  // Сумма ЗНАЕМЫХ цен записанного — для сверки на стороне звонящего (руки
  // печатают её рядом с заявлением экшена). Строки с неизвестной ценой сюда
  // не входят и названы отдельно — unknown_cost.
  let knownCostUsd = 0;
  const failed: string[] = [];

  for (const row of body.rows) {
    const total = row.prompt_tokens + row.completion_tokens;
    const cacheCreation = row.cache_creation_tokens ?? null;
    const cacheRead = row.cache_read_tokens ?? null;
    // Нулевой расход не пишем: строка без токенов — не трата, а шум в книгах.
    // Строка из одного кэша — трата: чтение кэша оплачивается.
    if (total === 0 && (cacheCreation ?? 0) === 0 && (cacheRead ?? 0) === 0) continue;

    // Кэш — во входо-эквиваленте: его цена — доля цены входа, и считает её тот
    // же источник цен, что и вход. null — множителей вендора не знаем, и цена
    // строки честно неизвестна, а не посчитана без кэша.
    const promptEquivalent = inputEquivalentTokens(row.model, row.prompt_tokens, {
      creation: cacheCreation,
      read: cacheRead,
    });
    const { cost, basis } = promptEquivalent === null
      ? { cost: null, basis: 'unknown' as const }
      : await resolveCostUsd(row.model, promptEquivalent, row.completion_tokens);
    if (cost === null) unknownCost += 1;

    try {
      await pool.query(
        `INSERT INTO llm_usage_log
           (id, route, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, cost_basis, agent_id,
            cache_creation_tokens, cache_read_tokens, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [row.model, row.prompt_tokens, row.completion_tokens, total, cost, basis, row.agent_id ?? null,
          cacheCreation, cacheRead],
      );
      written += 1;
      if (cost !== null) knownCostUsd += cost;
    } catch (e) {
      // Отказ не глушится (§4.0): «не записали» не равно «не тратили», и
      // звонящий обязан узнать, что его расход в книги НЕ попал.
      const message = e instanceof Error ? e.message : 'INSERT не выполнен';
      console.error('[llm-usage-report] строка не записана:', row.model, message);
      failed.push(row.model);
    }
  }

  // Частичный отказ — не успех. 207: часть записана, часть нет, и обе цифры
  // названы. Молчаливый 200 при половине потерянных строк был бы ровно тем
  // «зелёным при мёртвой карточке», от которого лечится §4.0.
  const status = failed.length === 0 ? 200 : 207;
  return NextResponse.json({
    ok: failed.length === 0,
    written,
    failed: failed.length,
    failed_models: failed.slice(0, 20),
    unknown_cost: unknownCost,
    cost_usd_known: Math.round(knownCostUsd * 1e6) / 1e6,
  }, { status });
}
