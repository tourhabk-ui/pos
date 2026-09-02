/**
 * GET /api/ai/debug-waterfall
 * Диагностика: зовёт каждого AI-провайдера настоящим промптом и отдаёт
 * подробные ошибки. Только по CRON_SECRET в заголовке `Authorization: Bearer`.
 *
 * ── Что закрыто 01.09 (аудит периметра) ──────────────────────────────────
 *
 * До этого дня у роута был режим `?check=env` БЕЗ секрета: карта настроенных
 * провайдеров, первые 12 символов ключа OpenRouter и его длина — любому, кто
 * знает адрес. Не ключ, но инвентарь для сканера: какие провайдеры
 * подключены и какого формата ключ. Режим удалён; карта ключей осталась
 * только в полном ответе, под секретом, и без префикса ключа — отпечаток
 * ключа есть на /hub/admin/health (`lib/ai/key-identity.ts`).
 *
 * Секрет принимался параметром `?secret=` — он оседает в access-логах прокси
 * и Timeweb. Теперь только заголовок: параметр не читается вовсе, даже как
 * запасной путь. Единственный вызывающий — `.github/workflows/ai-debug.yml`,
 * переведён на заголовок тем же коммитом.
 *
 * Без верного секрета на проде — 404, а не 403 с подсказкой: адрес не
 * должен подтверждать своё существование. Вне прода — 401 с диагнозом, как у
 * кронов (`diagnoseCronAuth`), чтобы разработчик видел, что именно не дошло.
 */
import { NextRequest, NextResponse } from 'next/server';
import { callAIWaterfallDebug } from '@/lib/ai/providers';
import { getSystemPrompt } from '@/lib/ai/prompts';
import type { ChatMessage } from '@/lib/ai/prompts';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';

const PROVIDER_KEYS = [
  'DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_GROUP_ID', 'OR_API_KEY',
  'OPENROUTER_API_KEY', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID', 'XIAOMI_API_KEY',
  'GEMINI_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'FUGU_API_KEY',
  'GLM_API_KEY', 'NVIDIA_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY',
] as const;

/** Секрет принимается ТОЛЬКО заголовком: без него — как без секрета. */
function authorized(request: NextRequest): boolean {
  if (!request.headers.get('authorization')) return false;
  return verifyCronSecret(request);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: 'Unauthorized', ...diagnoseCronAuth(request) },
      { status: 401 },
    );
  }

  const testMessage = request.nextUrl.searchParams.get('q') || 'Привет, расскажи коротко про вулканы Камчатки';

  const systemPrompt = getSystemPrompt('tourist');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt, timestamp: Date.now() },
    { role: 'user', content: testMessage, timestamp: Date.now() },
  ];

  const started = Date.now();
  const results = await callAIWaterfallDebug(messages);
  const totalMs = Date.now() - started;

  const working = results.filter(r => r.status === 'success');
  const failed = results.filter(r => r.status !== 'success');

  const envKeys: Record<string, boolean> = {};
  for (const k of PROVIDER_KEYS) envKeys[k] = !!process.env[k];

  return NextResponse.json({
    success: true,
    total_ms: totalMs,
    test_message: testMessage,
    system_prompt_length: systemPrompt.length,
    summary: {
      total_providers: results.length,
      working: working.length,
      failed: failed.length,
    },
    results,
    env_keys: envKeys,
  });
}
