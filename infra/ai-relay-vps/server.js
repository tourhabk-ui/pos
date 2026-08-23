/**
 * Ведар — AI-релей для VPS (Node 18+, без зависимостей).
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ ВОРКЕРА. Cloudflare-воркер `infra/ai-relay/` написан
 * верно и работает: с нейтрального адреса он проксирует OpenRouter и
 * отдаёт 200 (проба 168, 690 КБ списка моделей). Но задачу, ради которой
 * он делался, он НЕ решает.
 *
 * Замер 23.08: с раннера GitHub оба пути живы, с прода на Timeweb (РФ) оба
 * отдают 403 с побайтово одинаковым телом
 * `{"success":false,"error":"Access denied by security policy."}` — это не
 * наш отказ, воркер такими словами не отвечает. Блокировка следует ЗА
 * ЗВОНЯЩИМ, а не за путём: тот же релей, вызванный из США, работает.
 *
 * Ведущее объяснение (не доказанное построчно, но единственное согласное
 * со всеми наблюдениями): OpenRouter стоит за Cloudflare, и субзапрос
 * воркера к Cloudflare-хосту доносит наверх `CF-Connecting-IP` исходного
 * клиента. Воркер честно вырезает этот заголовок в коде — но подставляется
 * он на edge, НИЖЕ уровня, где выполняется наш код. Спрятать российского
 * клиента воркером от апстрима за тем же Cloudflare нельзя.
 *
 * Отсюда VPS: хоп ВНЕ Cloudflare. Исходящий запрос уходит с его
 * собственного адреса, и никаких заголовков происхождения к нему не
 * приклеено.
 *
 * ОТЛИЧИЯ ОТ ВОРКЕРА, СОЗНАТЕЛЬНЫЕ:
 *   - секрет ОБЯЗАТЕЛЕН, а не опционален. У воркера адрес неугадываемый и
 *     Cloudflare прикрывает от сканеров; VPS с публичным адресом находят
 *     сканами за часы. Открытый релей к LLM — это чужие запросы под нашим
 *     адресом, даже если ключи ходят от клиента и мы их не храним.
 *   - тело буферизуется целиком. Стриминг запроса в Node требует
 *     duplex-полуоткрытия и лишней осторожности, а запросы к LLM мелкие;
 *     ОТВЕТ при этом стримится как есть, чтобы не копить длинные генерации
 *     в памяти.
 */

const http = require('node:http');
const { Readable } = require('node:stream');

/** Апстримы захардкожены: это НЕ открытый прокси. */
const UPSTREAMS = {
  or: 'https://openrouter.ai',
  anthropic: 'https://api.anthropic.com',
  'gh-api': 'https://api.github.com',
  'gh-raw': 'https://raw.githubusercontent.com',
};

/**
 * Заголовки, которые нельзя переносить в исходящий запрос.
 *
 * Первые — hop-by-hop и хостовые. Остальные — следы происхождения: именно
 * из-за такого следа не сработал воркер, и здесь их не должно быть ни
 * одного. `forwarded` включён по RFC 7239 — он несёт то же самое.
 */
const STRIP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
  'forwarded', 'x-relay-secret',
]);

const PORT = Number(process.env.PORT || 8080);
const RELAY_SECRET = process.env.RELAY_SECRET || '';
/** Потолок ожидания апстрима: генерация флагмана бывает долгой. */
const UPSTREAM_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS || 120_000);
/** Потолок тела запроса — защита от заливки мусора в открытый порт. */
const MAX_BODY_BYTES = Number(process.env.RELAY_MAX_BODY || 2_000_000);

if (!RELAY_SECRET) {
  // Падаем на старте, а не работаем открытым прокси. Молчаливый запуск без
  // секрета — ровно тот случай, когда «работает» и «безопасно» расходятся.
  console.error('RELAY_SECRET не задан — отказываюсь стартовать открытым релеем');
  process.exit(1);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/** Сравнение секрета без утечки по времени. */
function secretOk(given) {
  const a = Buffer.from(given || '', 'utf8');
  const b = Buffer.from(RELAY_SECRET, 'utf8');
  if (a.length !== b.length) return false;
  return require('node:crypto').timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Проба живости — ДО проверки секрета и намеренно без него.
  //
  // Платформа (App Platform, k8s, балансировщик) дёргает какой-то адрес и
  // ждёт 200. Наш корень отвечает 403, потому что секрета в проверке нет, —
  // и приложение попало бы в цикл перезапусков, выглядящий как «релей не
  // работает». Отвечаем фактом о себе и ничем больше: ни версии, ни
  // окружения, ни апстримов. Знание, что по адресу живёт сервер, не тайна;
  // всё остальное — тайна.
  const path = req.url.split('?')[0];
  if (path === '/healthz' || path === '/') {
    return json(res, 200, { ok: true });
  }

  if (!secretOk(req.headers['x-relay-secret'])) {
    return json(res, 403, { error: 'forbidden' });
  }

  const url = new URL(req.url, 'http://placeholder');
  const seg = url.pathname.split('/').filter(Boolean);
  const base = UPSTREAMS[seg[0]];
  if (!base) {
    return json(res, 404, { error: 'unknown_upstream', hint: 'use /or/, /anthropic/, /gh-api/ or /gh-raw/' });
  }

  const target = base + '/' + seg.slice(1).join('/') + url.search;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP.has(k.toLowerCase())) headers[k] = v;
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch {
      return json(res, 413, { error: 'body_too_large' });
    }
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    // Причина в лог — не клиенту. Клиенту хватает того, что апстрим не
    // ответил; детали ошибки наружу отдавать незачем.
    console.error('upstream_unreachable', seg[0], err && err.name);
    return json(res, 502, { error: 'relay_upstream_unreachable' });
  }

  const out = {};
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'transfer-encoding') out[k] = v;
  });
  res.writeHead(upstream.status, out);

  if (!upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body).pipe(res);
});

server.listen(PORT, () => {
  // Ключи и секрет не логируются нигде: релей их только переносит.
  console.log(`ai-relay-vps слушает :${PORT}, апстримы: ${Object.keys(UPSTREAMS).join(', ')}`);
});
