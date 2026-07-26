/**
 * GET /api/admin/evo/models — какие модели провайдеров могут участвовать в
 * эволюции. Для каждого провайдера решателя (DeepSeek, Qwen): список моделей из
 * /v1/models, разметка «годна/отсеяна + причина», текущий выбор resolver'а и
 * ручной override из env. Требует роль admin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getProviderModelIds, getAnthropicModelIds } from '@/lib/ai/providers';
import { getOpenRouterKey, getAnthropicKey } from '@/lib/ai/provider-config';
import { classifyModels, pickBestModel, pickBestFlagship } from '@/lib/ai/model-resolver';

export const dynamic = 'force-dynamic';

/**
 * Экран показывал только DeepSeek и Qwen и звал DeepSeek «первичным», хотя с
 * PR #751-753 ПЕРВЫМ в callAIDecision идёт флагман (Claude через OpenRouter, а
 * при отказе — напрямую через Anthropic). То есть страница врала о собственном
 * решателе: владелец видел два фоллбэка и не видел главного звена.
 *
 * Флагман устроен иначе, чем DeepSeek/Qwen: его id ЗАПИНЕН (EVO_FLAGSHIP_MODEL),
 * а не выбирается из /v1/models, поэтому в списке моделей у него пусто —
 * показываем сам пин и наличие ключей.
 */
const FLAGSHIP_ENV = 'EVO_DECISION_FLAGSHIP_MODEL';
const FLAGSHIP_DEFAULT = 'anthropic/claude-opus-5';

const PROVIDERS: Array<{ key: 'deepseek' | 'qwen'; label: string; overrideEnv: string; role: string }> = [
  { key: 'deepseek', label: 'DeepSeek', overrideEnv: 'EVO_DECISION_MODEL', role: 'резерв (доступен из РФ)' },
  { key: 'qwen', label: 'Qwen (DashScope)', overrideEnv: 'EVO_DECISION_QWEN_MODEL', role: 'на подхвате' },
];

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const providers = await Promise.all(
    PROVIDERS.map(async (p) => {
      const ids = await getProviderModelIds(p.key);
      const models = classifyModels(ids);
      const override = process.env[p.overrideEnv] || null;
      const autoPick = pickBestModel(ids);
      return {
        key: p.key,
        label: p.label,
        role: p.role,
        override_env: p.overrideEnv,
        override,
        // Активная модель: override выигрывает, иначе авто-выбор
        active: override || autoPick,
        auto_pick: autoPick,
        eligible_count: models.filter((m) => m.eligible).length,
        total_count: models.length,
        has_key: ids.length > 0,
        models,
      };
    }),
  );

  // Флагман — первое звено waterfall. Как DeepSeek/Qwen, теперь резолвится из
  // /v1/models (pickBestFlagship), а не прибит к id. «Запинен» — только если
  // задан env-override.
  const flagshipOverride = process.env[FLAGSHIP_ENV] || null;
  const hasOr = !!getOpenRouterKey();
  const hasAnthropic = !!getAnthropicKey();
  const flagshipIds = await getAnthropicModelIds();
  const autoPickBare = pickBestFlagship(flagshipIds);
  const autoPick = autoPickBare ? `anthropic/${autoPickBare}` : null;
  const flagshipActive = flagshipOverride || autoPick || FLAGSHIP_DEFAULT;
  const path = [hasOr && 'OpenRouter', hasAnthropic && 'Anthropic напрямую'].filter(Boolean).join(' + ');

  const flagship = {
    key: 'flagship' as const,
    label: 'Claude (флагман)',
    role: 'первичный',
    override_env: FLAGSHIP_ENV,
    override: flagshipOverride,
    active: flagshipActive,
    auto_pick: autoPick,
    eligible_count: autoPickBare ? 1 : (hasOr || hasAnthropic ? 1 : 0),
    total_count: flagshipIds.length || 1,
    has_key: hasOr || hasAnthropic,
    models: [] as ReturnType<typeof classifyModels>,
    pinned: !!flagshipOverride,
    note: flagshipOverride
      ? `id закреплён override ${FLAGSHIP_ENV}=${flagshipOverride}`
      : autoPick
        ? `авто-выбор сильнейшего из /v1/models: ${autoPick}. Пути: ${path}. Достижимость — /api/ai/relay-check`
        : (hasOr || hasAnthropic)
          ? `авто-резолв недоступен (/v1/models пуст) — фоллбэк ${FLAGSHIP_DEFAULT}. Пути: ${path}. Достижимость — /api/ai/relay-check`
          : 'нет ни OPENROUTER_API_KEY, ни ANTHROPIC_API_KEY — решение уходит на DeepSeek/Qwen',
  };

  return NextResponse.json({ success: true, providers: [flagship, ...providers] });
}
