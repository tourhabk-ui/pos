/**
 * GET /api/cron/ai-models — какие модели РЕАЛЬНО доступны нашим ключам.
 *
 * Повод (23.08). Вопрос «а какую модель поставить» решался до сих пор
 * памятью и примерами из чужой документации — там всплыл `qwen3.8-max`,
 * имени которого никто не проверял. У нас id не хардкодится намеренно
 * (§8 CLAUDE.md): резолвер спрашивает `/v1/models` сам. Но человеку,
 * который выбирает override, спросить было НЕЧЕМ, и он выбирал вслепую.
 *
 * Роут показывает три разные вещи, которые легко перепутать:
 *   available — что отдаёт провайдер по нашему ключу;
 *   configured — что стоит в конфиге по умолчанию (им ходит tools-путь
 *     Кузьмича и диагностика ключа);
 *   resolved — что ВЫБЕРЕТ резолвер для каждого назначения.
 *
 * Расхождение между configured и resolved — не ошибка, а причина, по
 * которой диагностика ключа может краснеть при живом рабочем пути: они
 * спрашивают разные модели, и квота у моделей считается раздельно.
 *
 * Значения env НЕ печатаются — только факт, задана переменная или нет.
 * Ключи и override могут содержать секреты, а вопрос здесь другой.
 *
 * Ничего не пишет. Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import {
  probeProviderModels, getQwenConfig,
  resolveChatModel, resolveContentModel, resolveDecisionModel,
} from '@/lib/ai/providers';
import { pickBestModel } from '@/lib/ai/model-resolver';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PROVIDERS = ['qwen', 'deepseek'] as const;
type Provider = typeof PROVIDERS[number];

/** Переменные-override по назначениям — печатаем ИМЕНА и факт наличия. */
const OVERRIDES: Record<Provider, Record<string, string>> = {
  qwen: {
    chat: 'QWEN_MODEL',
    content: 'CONTENT_QWEN_MODEL',
    decision: 'EVO_DECISION_QWEN_MODEL',
    vision: 'QWEN_VISION_MODEL',
  },
  deepseek: {
    chat: 'CHAT_MODEL',
    content: 'CONTENT_MODEL',
    decision: 'EVO_DECISION_MODEL',
  },
};

async function describe(provider: Provider) {
  const listed = await probeProviderModels(provider);

  // Резолвер спрашивать безопасно: он сам падает на алиас и не бросает.
  // Но если список не получен, «выбрал бы» — это уже догадка, и её надо
  // называть догадкой, а не результатом.
  const [chat, content, decision] = await Promise.all([
    resolveChatModel(provider).catch(() => null),
    resolveContentModel(provider).catch(() => null),
    resolveDecisionModel(provider).catch(() => null),
  ]);

  const overrides = Object.fromEntries(
    Object.entries(OVERRIDES[provider]).map(([purpose, env]) => [
      purpose, { env, set: Boolean(process.env[env]) },
    ]),
  );

  return {
    provider,
    available: listed.ok ? listed.ids : null,
    available_total: listed.ok ? listed.ids.length : null,
    // Третий исход назван: список не получен ≠ моделей нет.
    list_failed: listed.ok ? null : { http_status: listed.http_status, detail: listed.detail },
    best_by_rule: listed.ok ? (pickBestModel(listed.ids) ?? null) : null,
    configured: provider === 'qwen' ? getQwenConfig().model : null,
    base: provider === 'qwen' ? getQwenConfig().base : 'https://api.deepseek.com',
    resolved: { chat, content, decision },
    overrides,
  };
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const providers = await Promise.all(PROVIDERS.map(describe));
    return NextResponse.json({ success: true, probe: 'ai_models_v1', providers });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка перечня моделей';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
