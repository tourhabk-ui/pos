/**
 * GET /api/ai/health?token=kamhub-debug-2026
 * Диагностика AI-провайдеров в продакшене.
 * Требует debug-токен в query string.
 */

import { NextRequest, NextResponse } from 'next/server';
import { callAIWaterfallDebug } from '@/lib/ai/providers';
import { getOpenRouterKey, getMiMoKey, getDeepSeekKey, getAnthropicKey, getGeminiKey, getXaiKey, getYandexKey, getMiniMaxKey, getGLMKey } from '@/lib/ai/provider-config';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const DEBUG_TOKEN = 'kamhub-debug-2026';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (token !== DEBUG_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const orKey = getOpenRouterKey();
  const mimoKey = getMiMoKey();
  const dsKey = getDeepSeekKey();
  const anthKey = getAnthropicKey();
  const gemKey = getGeminiKey();
  const xaiKey = getXaiKey();

  const keySummary = {
    OR_API_KEY:          orKey   ? `SET (${orKey.slice(0, 8)}...)`   : 'MISSING',
    XIAOMI_API_KEY:      mimoKey ? `SET (${mimoKey.slice(0, 8)}...)` : 'MISSING',
    DEEPSEEK_API_KEY:    dsKey   ? `SET (${dsKey.slice(0, 8)}...)`   : 'MISSING',
    ANTHROPIC_API_KEY:   anthKey ? `SET (${anthKey.slice(0, 8)}...)` : 'MISSING',
    GEMINI_API_KEY:      gemKey  ? `SET (${gemKey.slice(0, 8)}...)`  : 'MISSING',
    XAI_API_KEY:         xaiKey  ? `SET (${xaiKey.slice(0, 8)}...)`  : 'MISSING',
    YANDEX_API_KEY:      getYandexKey()  ? 'SET' : 'MISSING',
    MINIMAX_API_KEY:     getMiniMaxKey() ? 'SET' : 'MISSING (needs MINIMAX_API_KEY + MINIMAX_GROUP_ID)',
    GLM_API_KEY:         getGLMKey()     ? 'SET' : 'MISSING',
    NVIDIA_API_KEY:      process.env.NVIDIA_API_KEY ? 'SET' : 'MISSING',
    DATABASE_URL:        process.env.DATABASE_URL  ? 'SET' : 'MISSING',
    JWT_SECRET:          process.env.JWT_SECRET    ? 'SET' : 'MISSING',
    BRIGHTDATA_TOKEN:    process.env.BRIGHTDATA_TOKEN ? 'SET' : 'MISSING',
    TELEGRAM_BOT_TOKEN:  process.env.TELEGRAM_BOT_TOKEN ? 'SET' : 'MISSING',
  };

  const testMessages = [{ role: 'user' as const, content: 'Ответь одним словом: работаю' }];
  const providerTests = await callAIWaterfallDebug(testMessages);

  const working = providerTests.filter(r => r.status === 'success');
  const missing = providerTests.filter(r => r.status === 'no_key');
  const failed = providerTests.filter(r => r.status !== 'success' && r.status !== 'no_key');

  return NextResponse.json({
    summary: {
      total_providers: providerTests.length,
      working: working.length,
      missing_key: missing.length,
      failed: failed.length,
      ai_available: working.length > 0,
    },
    keys: keySummary,
    providerTests,
    nodeVersion: process.version,
    nodeEnv: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
}
