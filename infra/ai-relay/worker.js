/**
 * Ведар — AI-релей (Cloudflare Worker).
 *
 * Зачем задумывался: прод на Timeweb (РФ). openrouter.ai и api.anthropic.com
 * блокируют РФ-IP → флагманские модели недостижимы, и waterfall молча падает
 * на DeepSeek/Qwen. Воркер живёт на edge Cloudflare (вне РФ) и прозрачно
 * проксирует запросы к апстримам. Ключи приходят в заголовке Authorization от
 * нашего сервера и форвардятся как есть — воркер их не хранит и не логирует.
 *
 * ВНИМАНИЕ (23.08): С OPENROUTER И ANTHROPIC ЭТОТ ЗАМЫСЕЛ НЕ РАБОТАЕТ.
 *
 * Воркер исправен: с раннера GitHub он проксирует openrouter.ai и отдаёт 200
 * (проба 168, 690 КБ списка моделей). Но с прода на Timeweb тот же релей
 * отдаёт 403 с телом `{"success":false,"error":"Access denied by security
 * policy."}` — таких слов воркер выдать не может, это чужой отказ. Блокировка
 * следует ЗА ЗВОНЯЩИМ, а не за путём.
 *
 * Ведущее объяснение (со всеми наблюдениями согласно, построчно не доказано):
 * OpenRouter стоит за Cloudflare, и субзапрос воркера к Cloudflare-хосту
 * доносит наверх CF-Connecting-IP исходного клиента. Список STRIP ниже
 * вырезает этот заголовок честно — но подставляется он на edge, НИЖЕ уровня,
 * где выполняется наш код. Воркер Cloudflare не спрячет клиента от апстрима,
 * который сам за Cloudflare.
 *
 * Для флагманов нужен хоп ВНЕ сети Cloudflare — см. `infra/ai-relay-vps/`.
 * Здесь воркер остаётся живым и полезным для gh-api/gh-raw: GitHub за
 * Cloudflare не стоит, и этот путь с прода работает.
 *
 * Маршрутизация по первому сегменту пути:
 *   /or/<путь>        → https://openrouter.ai/<путь>
 *   /anthropic/<путь> → https://api.anthropic.com/<путь>
 *   /gh-api/<путь>    → https://api.github.com/<путь>
 *   /gh-raw/<путь>    → https://raw.githubusercontent.com/<путь>
 *
 * gh-api/gh-raw нужны эволюции: прод на Timeweb (РФ), исходников в
 * standalone-бандле нет, скан читает репо из GitHub — а он из РФ может не
 * достаться. Релей (edge вне РФ) проксирует и это чтение.
 *
 * Настройка на Timeweb (переменные окружения приложения):
 *   OPENROUTER_BASE_URL = https://<ваш-воркер>.workers.dev/or/api/v1
 *   ANTHROPIC_BASE_URL  = https://<ваш-воркер>.workers.dev/anthropic
 *   GITHUB_PROXY_BASE   = https://<ваш-воркер>.workers.dev   (без хвостового /)
 *
 * Деплой: `npx wrangler deploy` (см. README.md рядом).
 *
 * Безопасность: апстримы захардкожены (нельзя проксировать на произвольный
 * хост — не открытый прокси). Опционально можно включить проверку общего
 * секрета — см. RELAY_SECRET ниже и README.
 */

const UPSTREAMS = {
  or: 'https://openrouter.ai',
  anthropic: 'https://api.anthropic.com',
  'gh-api': 'https://api.github.com',
  'gh-raw': 'https://raw.githubusercontent.com',
};

// Заголовки, которые нельзя переносить в исходящий запрос (hop-by-hop / хостовые).
const STRIP_REQUEST_HEADERS = new Set(['host', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']);

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Необязательная защита от чужого использования: если задан RELAY_SECRET,
    // требуем совпадающий заголовок X-Relay-Secret.
    if (env && env.RELAY_SECRET) {
      if (request.headers.get('x-relay-secret') !== env.RELAY_SECRET) {
        return json({ error: 'forbidden' }, 403);
      }
    }

    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean); // ['or','api','v1','chat','completions']
    const key = seg[0];
    const base = UPSTREAMS[key];
    if (!base) {
      return json({ error: 'unknown_upstream', hint: 'use /or/, /anthropic/, /gh-api/ or /gh-raw/' }, 404);
    }

    const rest = '/' + seg.slice(1).join('/');
    const target = base + rest + url.search;

    const headers = new Headers();
    for (const [k, v] of request.headers) {
      if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase()) && k.toLowerCase() !== 'x-relay-secret') {
        headers.set(k, v);
      }
    }

    const init = {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    };

    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch {
      // Не отдаём детали ошибки/стек клиенту (CodeQL: information exposure).
      return json({ error: 'relay_upstream_unreachable' }, 502);
    }

    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) respHeaders.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Relay-Secret,HTTP-Referer,X-Title,anthropic-version,x-api-key',
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
