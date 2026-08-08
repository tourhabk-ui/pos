/**
 * Next.js Instrumentation — app startup initialization
 *
 * On server startup, this performs:
 * 1. AI model warm-up (MiniLM embeddings)
 * 2. Agent platform initialization (scheduler, event bus)
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

/**
 * Прод-ошибки в петлю эволюции (Эволюция 3.0, п.1). Каждая серверная ошибка
 * запроса пишется в ai_actions_log (action_type='server_error'); ночной Evo
 * читает журнал объективом scanProdErrors и рождает находки. До этого 500-ки
 * прода не попадали в петлю вовсе: мёртвый /time-slots и вечный degraded
 * /api/tours жили годами и вскрылись только ручной пробой 08.08.
 *
 * Троттлинг per-route (60 с): штормовая ошибка не заливает журнал — для
 * находки важен факт и последнее сообщение, а не каждый повтор.
 */
const errorLoggedAt = new Map<string, number>();
const ERROR_LOG_THROTTLE_MS = 60_000;

export async function onRequestError(
  err: unknown,
  request: { path?: string; method?: string },
  context: { routePath?: string; routeType?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const route = context?.routePath || request?.path || 'unknown';
    const now = Date.now();
    if (now - (errorLoggedAt.get(route) ?? 0) < ERROR_LOG_THROTTLE_MS) return;
    errorLoggedAt.set(route, now);

    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const { query } = await import('@/lib/database');
    await query(
      `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
      ['server_error', JSON.stringify({
        route,
        method: request?.method ?? null,
        kind: context?.routeType ?? null,
        message,
      })],
    );
  } catch { /* журнал не должен усугублять ошибку, которую фиксирует */ }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // ── 0. Global safety net ───────────────────────────────────
    // Native modules in transformers/onnxruntime/sharp can throw during
    // lazy import on Alpine/musl. Do not let them kill the process and
    // fail Timeweb healthcheck — log and continue serving /api/health.
    process.on('unhandledRejection', (reason) => {
      console.error('[unhandledRejection]', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[uncaughtException]', err);
    });

    // ── 1. Warm up AI embeddings model ────────────────────────────────
    // NOTE: disabled eager warm-up — @huggingface/transformers pulls sharp
    // which crashes container on startup in Timeweb Alpine image.
    // First search request will lazy-load the model instead.
    // try {
    //   const { warmModel } = await import('@/lib/ai/embeddings');
    //   warmModel().catch(() => {});
    // } catch { /* best-effort */ }

    // ── 2. Register MAX bot webhook ───────────────────────────────────
    const maxToken = process.env.MAX_BOT_TOKEN;
    if (maxToken) {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://tourhab.ru';
      const webhookUrl = `${baseUrl}/api/max/kuzmich`;
      try {
        // Check existing subscription first.
        // MAX Bot API v2 host — старый platform-api.max.ru выведен из эксплуатации,
        // пакет @maxhub/max-bot-api уже по умолчанию использует platform-api2.max.ru.
        const checkRes = await fetch('https://platform-api2.max.ru/subscriptions', {
          headers: { Authorization: maxToken },
        });
        const checkData = await checkRes.json() as { subscriptions?: Array<{ url: string }> };
        const alreadyRegistered = checkData.subscriptions?.some((s) => s.url === webhookUrl);
        if (!alreadyRegistered) {
          await fetch('https://platform-api2.max.ru/subscriptions', {
            method: 'POST',
            headers: { Authorization: maxToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: webhookUrl,
              update_types: ['bot_started', 'message_created', 'message_callback'],
            }),
          });
        }
      } catch {
        // Non-blocking: webhook registration is best-effort
      }
    }
  }
}
