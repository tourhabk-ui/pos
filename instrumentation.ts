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
 * Троттлинг per-route (ERROR_LOG_THROTTLE_MS): штормовая ошибка не заливает
 * журнал — для находки важен факт и последнее сообщение, а не каждый повтор.
 * Число живёт в lib/server-errors/log-throttle: его читает и суточный дайджест
 * владельцу, чтобы назвать свои счётчики нижней границей (аудит 15.10, P4-17).
 */
import { ERROR_LOG_THROTTLE_MS } from '@/lib/server-errors/log-throttle';

const errorLoggedAt = new Map<string, number>();

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
      // Текст ошибки, кадры стека, адрес и маршрут чистятся ДО записи (Д4-4,
      // аудит 15.10): журнал читают объектив эволюции (текст уходит в GitHub
      // Issue и в промпт) и суточный дайджест владельцу в Telegram, а в тексте
      // ошибки бывает почта из формы, телефон из ключа уникальности, адрес с
      // ключом в query. Та же чистка, что у ловушки ошибок браузера. Импорт
      // динамический по той же причине, что и у базы ниже: модуль тянет
      // node:crypto, которому не место в edge-бандле.
      const { scrubErrorText } = await import('@/lib/client-errors/scrub');
      // Без шаблона маршрута (routePath) маршрутом становится сырой адрес —
      // с query и сегментами, где бывает что угодно, включая ПД.
      const route = scrubErrorText(context?.routePath || (request?.path ?? '').split('?')[0], 200) || 'unknown';
      const now = Date.now();
      if (now - (errorLoggedAt.get(route) ?? 0) < ERROR_LOG_THROTTLE_MS) return;
      errorLoggedAt.set(route, now);

      const message = scrubErrorText(err instanceof Error ? err.message : String(err), 300);
      // Ошибка рендера в боевой сборке приходит с замазанным текстом («The
      // specific message is omitted in production builds»): 4 ошибки
      // /routes/[id] за неделю (prod-check run 85, 03.10) нельзя было ни
      // воспроизвести, ни сличить с логом сервера. Поэтому рядом пишутся
      // КОНКРЕТНЫЙ адрес (без query — там может быть что угодно), digest —
      // ключ, по которому Next печатает настоящую ошибку в лог контейнера, —
      // и первые кадры стека, если они есть.
      // Путь чистится той же функцией: ключ заявки или почта в сегменте
      // адреса — не реже, чем в query.
      const path = scrubErrorText((request?.path ?? '').split('?')[0], 200) || null;
      const digest = typeof (err as { digest?: unknown })?.digest === 'string'
        ? ((err as { digest: string }).digest).slice(0, 64) : null;
      const frames = err instanceof Error && typeof err.stack === 'string'
        ? err.stack.split('\n').slice(1, 4).map(l => l.trim()).join(' | ') : '';
      const stack = scrubErrorText(frames, 400) || null;
      const { query } = await import('@/lib/database');
      await query(
        `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
        ['server_error', JSON.stringify({
          route,
          path,
          digest,
          stack,
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

    // ── 2. Подписка бота MAX ──────────────────────────────────────────
    // Адрес — maxWebhookUrl() с ключом, путь — maxFetch (корень Минцифры),
    // отказ — в лог с замаскированным адресом, повтор с паузами и тревога в
    // рабочий чат; без ключа не подписываем ничего (почему — в шапке
    // lib/max/startup-subscription). Не ждём: старт сервера не стоит в
    // очереди за сетью MAX.
    if (process.env.MAX_BOT_TOKEN) {
      void import('@/lib/max/startup-subscription')
        .then(({ subscribeMaxOnStart }) => subscribeMaxOnStart())
        .catch((err: unknown) => {
          console.error('[max] подписка при старте не выполнилась:', err instanceof Error ? err.message : String(err));
        });
    }
  }
}
