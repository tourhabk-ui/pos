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
  probeProviderModels, getQwenConfig, qwenRefusalKind,
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

/**
 * `?ping=1` — ответит ли КАЖДАЯ нужная модель Qwen (25.09).
 *
 * Health пробует одну модель (qwen-plus) и сообщает «у модели нет квоты».
 * Владелец: «Проверь Qwen». Одна модель не отвечает на вопрос, что сломано:
 * квоты DashScope считаются по моделям раздельно, и «Free tier only»
 * режет только те, у которых бесплатная квота кончилась. Здесь каждая
 * модель, которой платформа реально ходит (настроенная, выбранные
 * резолвером, зрение), получает запрос на один токен — и отвечает своим
 * исходом. Все «quota» — переключатель стоит на всех; часть — только у них.
 *
 * Токен на модель — копейки и только по явной просьбе (?ping=1).
 */
async function pingQwen(models: string[]) {
  const { apiKey, base } = getQwenConfig();
  if (!apiKey) return { key_set: false, results: [] as unknown[] };
  const results = await Promise.all(models.map(async (model) => {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(15_000),
      });
      // Сообщение DashScope — целиком: в его хвосте сказано, ГДЕ снять
      // ограничение, и срез на 160 знаках обрывал ровно эту часть (25.09).
      const body = (await res.text()).slice(0, 800);
      const kind = res.ok ? 'ok' : (qwenRefusalKind(res.status, body) ?? 'error');
      const code = body.match(/"code"\s*:\s*"([^"]{1,60})"/)?.[1] ?? null;
      return { model, http_status: res.status, verdict: kind, code, ms: Date.now() - started,
        detail: res.ok ? null : body.replace(/\s+/g, ' ').slice(0, 600) };
    } catch (err) {
      // Сеть не дошла — «не смог», а не «нет квоты» (§4.0).
      return { model, http_status: null, verdict: 'net', code: null, ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err) };
    }
  }));
  return { key_set: true, base, results };
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const providers = await Promise.all(PROVIDERS.map(describe));
    if (request.nextUrl.searchParams.get('ping') !== '1') {
      return NextResponse.json({ success: true, probe: 'ai_models_v1', providers });
    }
    const q = providers.find(p => p.provider === 'qwen');
    const wanted = [
      q?.configured, q?.resolved.chat, q?.resolved.content, q?.resolved.decision,
      process.env.QWEN_VISION_MODEL || 'qwen-vl-max',
    ].filter((m): m is string => typeof m === 'string' && m.length > 0);
    const models = [...new Set(wanted)];
    return NextResponse.json({ success: true, probe: 'ai_models_v1', providers, qwen_ping: await pingQwen(models) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка перечня моделей';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
