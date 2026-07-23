/**
 * GET /api/admin/evo/models — какие модели провайдеров могут участвовать в
 * эволюции. Для каждого провайдера решателя (DeepSeek, Qwen): список моделей из
 * /v1/models, разметка «годна/отсеяна + причина», текущий выбор resolver'а и
 * ручной override из env. Требует роль admin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getProviderModelIds } from '@/lib/ai/providers';
import { classifyModels, pickBestModel } from '@/lib/ai/model-resolver';

export const dynamic = 'force-dynamic';

const PROVIDERS: Array<{ key: 'deepseek' | 'qwen'; label: string; overrideEnv: string; role: string }> = [
  { key: 'deepseek', label: 'DeepSeek', overrideEnv: 'EVO_DECISION_MODEL', role: 'первичный' },
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

  return NextResponse.json({ success: true, providers });
}
