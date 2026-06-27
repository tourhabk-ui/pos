/**
 * Cloudflare Worker — прокси для Telegram Bot API.
 *
 * ЗАЧЕМ: сервер Timeweb (РФ) не может стабильно выходить на api.telegram.org
 * (РКН блокирует IP-диапазоны Telegram «заодно» с другими). Cloudflare не
 * блокируется — воркер выступает посредником: наш сервер → Cloudflare → Telegram.
 *
 * КАК РАЗВЕРНУТЬ (5 минут, бесплатно):
 *   1. Зайди на https://dash.cloudflare.com → Workers & Pages → Create → Create Worker
 *   2. Назови, например, "tg-proxy" → Deploy
 *   3. Нажми "Edit code" → удали весь шаблон → вставь СОДЕРЖИМОЕ ЭТОГО ФАЙЛА → Deploy
 *   4. Скопируй адрес воркера, вид: https://tg-proxy.ТВОЙ-САБДОМЕН.workers.dev
 *   5. В Timeweb (Fair Polydeuces → Переменные) добавь:
 *        TELEGRAM_API_BASE = https://tg-proxy.ТВОЙ-САБДОМЕН.workers.dev
 *      (БЕЗ слэша в конце!)
 *   6. Перезапусти приложение в Timeweb
 *
 * ПОСЛЕ ЭТОГО: бот, Кузьмич, дайджесты, МЧС-алерты пойдут через Cloudflare,
 * минуя блокировку. Проверь командой /checkchannels — должно быть ✅.
 *
 * БЕЗОПАСНОСТЬ: воркер слепо проксирует путь на api.telegram.org. Токен бота
 * идёт в URL как обычно (https). Воркер ничего не логирует и не хранит.
 * Опционально можно ограничить доступ по заголовку — см. блок ALLOW_SECRET ниже.
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Опциональная защита: раскомментируй и задай секрет, тогда в Timeweb
    // TELEGRAM_API_BASE = https://tg-proxy.xxx.workers.dev , а наш код должен
    // слать заголовок. По умолчанию — открытый прокси (путь содержит токен бота,
    // что само по себе является секретом).
    // const ALLOW_SECRET = 'поставь-длинную-случайную-строку';
    // if (request.headers.get('x-proxy-secret') !== ALLOW_SECRET) {
    //   return new Response('forbidden', { status: 403 });
    // }

    // Целевой URL: тот же путь и query, но хост — api.telegram.org
    const target = 'https://api.telegram.org' + url.pathname + url.search;

    // Проксируем метод, заголовки и тело без изменений
    const init = {
      method: request.method,
      headers: request.headers,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
      redirect: 'follow',
    };

    try {
      const resp = await fetch(target, init);
      // Возвращаем ответ Telegram как есть
      const headers = new Headers(resp.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(resp.body, { status: resp.status, headers });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error_code: 502, description: 'proxy fetch failed: ' + (e && e.message) }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
    }
  },
};
