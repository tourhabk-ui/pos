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
  // ПОЗИТИВНЫЙ if-блок, как в register() и доках Next, а не ранний return:
  // NEXT_RUNTIME инлайнится при сборке, и webpack выбрасывает недостижимую
  // ветку целиком. Ранний return он статически не устраняет — динамический
  // импорт lib/database утаскивал pg с node-builtins в edge-бандл, и build
  // падал «Can't resolve 'stream'» (первый прогон CI этого PR).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
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
}

/**
 * Сообщить владельцу о непригодной конфигурации. Best-effort: без токена
 * бота молчит, ошибку отправки не поднимает — задача не сорвать старт, а не
 * дать неисправности остаться незамеченной.
 */
function notifyBrokenConfig(fatal: string[]): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const text = ['<b>Платформа поднялась с непригодной конфигурацией</b>', '', ...fatal.map(f => `— ${f}`)].join('\n');
  void fetch(`${process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => {});
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

    // ── 0.5. Проверка конфигурации ────────────────────────────────────
    // `validateConfig()` была написана и не вызывалась ниоткуда: прод с
    // `JWT_SECRET`, равным строке-заглушке из примера, поднялся бы молча — а
    // это значит, что токен любого пользователя подделает кто угодно.
    //
    // Процесс намеренно НЕ убивается: выше стоят обработчики, которые держат
    // сервер живым ради healthcheck Timeweb, и брошенное здесь исключение они
    // же и проглотят. Поэтому громкость даётся тем каналом, который человек
    // действительно читает, — сообщением в Telegram, помимо лога.
    try {
      const { validateConfig } = await import('@/lib/config');
      const check = validateConfig();
      for (const w of check.warnings) console.error('[config] предупреждение:', w);
      if (check.fatal.length > 0) {
        for (const f of check.fatal) console.error('[config] НЕИСПРАВНО:', f);
        void notifyBrokenConfig(check.fatal);
      }
    } catch (err) {
      // Отказ самой проверки — не «конфигурация в порядке».
      console.error('[config] проверка конфигурации не выполнилась:', err);
    }

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
