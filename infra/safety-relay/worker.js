/**
 * Ведар — сейсмо-реле (Cloudflare Worker).
 *
 * ── Зачем ────────────────────────────────────────────────────────────────
 *
 * КБГС РАН и EQKam живут в Telegram, а `t.me` для нашего хостинга (Timeweb,
 * РФ) гео-закрыт. Поэтому страницы каналов тянет раннер GitHub и POST-ит их
 * на `/api/cron/safety-ingest`.
 *
 * Беда в расписании. Замер 29.08: планировщик GitHub доставляет 1-4% от
 * запрошенного — `safety-ingest` просит 288 прогонов в сутки, получал 2-4.
 * Отсюда «Сейсмо-канал Telegram отстаёт: 104 мин при норме 5» в отчёте
 * Watchdog, и починить это своими силами было нечем.
 *
 * Супервизор контейнера (`start.js`) тут не помогает ПО ПОСТРОЕНИЮ: он зовёт
 * наш же эндпоинт, а тот полез бы за `t.me` с прода — то есть в ту же стену.
 * Внешний планировщик (cron-job.org) — ровно так же: он дёргает наш адрес,
 * фетч всё равно уходит из РФ. Нужен тот, кто САМ сходит за страницей
 * снаружи. Раннер это умеет, но приходит когда захочет. Воркер приходит по
 * расписанию.
 *
 * ── Чего мы НЕ знаем заранее ─────────────────────────────────────────────
 *
 * Что это сработает. В соседнем `infra/ai-relay/worker.js` записан урок,
 * оплаченный временем: «воркер вне РФ, значит блокировка обойдена» оказалось
 * ЛОЖЬЮ для OpenRouter — тот сам стоит за Cloudflare, и субзапрос воркера
 * доносит наверх `CF-Connecting-IP` исходного клиента.
 *
 * Здесь случай другой: Telegram держит свою инфраструктуру, за Cloudflare не
 * стоит, а cron-триггер вообще не имеет исходного клиента — запрос
 * порождает сам Cloudflare. Но это РАССУЖДЕНИЕ, а не замер, и выдавать его
 * за факт нельзя. Поэтому есть `/selftest`: он ходит за теми же адресами и
 * отдаёт размеры ответов, ничего не отправляя на прод. Первый же его вызов
 * превращает рассуждение в измерение.
 *
 * ── Почему дубли не страшны ──────────────────────────────────────────────
 *
 * Раннер каждые пять минут шлёт страницу канала ЦЕЛИКОМ и заново — значит
 * дедуп на приёмнике обязан существовать с самого начала, иначе дубли пошли
 * бы в первый же день. Воркер шлёт то же самое тем же путём. Поэтому
 * воркфлоу GitHub не снимается: он остаётся независимой конечностью на
 * случай, если воркер встанет или Cloudflare начнёт получать отказ.
 */

/** Каналы Telegram: без них приёмник вернёт 400 — схема требует оба. */
const TG_REQUIRED = {
  kbgsras_html: 'https://t.me/s/kbgsras',
  eqkam_html: 'https://t.me/s/eqkam',
};

/** Необязательное: пусто — просто не кладём в тело (Zod допускает отсутствие). */
const TG_OPTIONAL = {
  minec_html: 'https://t.me/s/minec_tourism',
};

/**
 * ── Чего воркер НЕ делает: посты MAX ─────────────────────────────────────
 *
 * Канал МЧС в MAX остаётся целиком за раннером. Первая версия этого файла
 * тянула и его — вместе с копией извлечения постов из HTML, скопированной
 * из воркфлоу ради совпадения id (на них держится дедуп).
 *
 * Копию завернули сторожа `html-text` и `html-entities`, и по делу: вместе
 * с логикой копировался её дефект — `<\/script>` требовался ровно таким
 * (браузер принимает `</script >`, и тело скрипта уезжало в «текст»), а
 * `&amp;` разворачивался отдельной заменой, что позволяет цепочку.
 *
 * Чинить только здесь было нельзя: id разошлись бы с раннером и один пост
 * приехал бы дважды под разными именами — в канале МЧС это второй наряд по
 * одному сообщению. Чинить в обоих местах — это отдельная работа про MAX, а
 * не про опоздание сейсмо-канала, ради которого воркер и заводился.
 *
 * Поэтому здесь MAX нет вовсе: одна копия парсера лучше двух, а задача
 * воркера — Telegram КБГС и EQKam.
 */

/** У гос-сайта несколько путей; дубли снимет разбор на сервере. */
const KAMGOV_FEEDS = [
  'https://www.kamgov.ru/rss',
  'https://www.kamgov.ru/mintur/rss',
  'https://www.kamgov.ru/mintur/news/rss',
];

const UA = 'Mozilla/5.0 (compatible; KamchatourBot/1.0)';
const FETCH_TIMEOUT_MS = 30_000;

/** Ответ или ЧЕСТНАЯ причина его отсутствия — пустая строка молчит о причине. */
async function grab(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, bytes: 0 };
    const text = await res.text();
    return { ok: true, text, bytes: text.length };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), bytes: 0 };
  }
}

/** Собрать всё. Возвращает и тело, и перепись — чтобы отчёт не гадал. */
async function collect() {
  const census = {};
  const body = {};

  for (const [field, url] of Object.entries(TG_REQUIRED)) {
    const r = await grab(url);
    census[field] = r.ok ? `${r.bytes} байт` : `отказ: ${r.error}`;
    if (r.ok) body[field] = r.text;
  }

  for (const [field, url] of Object.entries(TG_OPTIONAL)) {
    const r = await grab(url);
    census[field] = r.ok ? `${r.bytes} байт` : `отказ: ${r.error}`;
    if (r.ok && r.text.trim()) body[field] = r.text;
  }

  const feeds = [];
  for (const url of KAMGOV_FEEDS) {
    const r = await grab(url);
    // Гос-сайт на несуществующий путь отдаёт HTML — это не лента.
    if (r.ok && /<rss|<feed/i.test(r.text)) feeds.push(r.text);
  }
  census.kamgov_xml = `${feeds.length} из ${KAMGOV_FEEDS.length} лент`;
  if (feeds.length > 0) body.kamgov_xml = feeds;

  return { body, census };
}

/**
 * Отправка. Если обязательного канала нет — НЕ отправляем: приёмник вернул
 * бы 400, и в журнале осталась бы «ошибка сервера» вместо правды «Telegram
 * не отдал страницу».
 */
async function relay(env) {
  const { body, census } = await collect();

  const missing = Object.keys(TG_REQUIRED).filter(f => !body[f]);
  if (missing.length > 0) {
    return { posted: false, reason: `не получены обязательные каналы: ${missing.join(', ')}`, census };
  }
  if (!env.CRON_SECRET) {
    return { posted: false, reason: 'секрет CRON_SECRET не задан у воркера', census };
  }

  const res = await fetch(`${env.INGEST_BASE || 'https://vedarai.ru'}/api/cron/safety-ingest`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  return { posted: res.ok, status: res.status, census };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      relay(env).then(r => {
        // Лог воркера — единственный след этого пути. Молчание здесь сделало
        // бы отказ реле неотличимым от отказа Telegram.
        console.log('[safety-relay]', JSON.stringify(r));
      }).catch(err => {
        console.error('[safety-relay] прогон упал:', err && err.message ? err.message : err);
      }),
    );
  },

  /**
   * `/selftest` — сходить за источниками и показать размеры, НИЧЕГО не
   * отправляя. Нужен, чтобы «воркер обходит блокировку» стало измерением, а
   * не рассуждением (см. урок про OpenRouter в шапке).
   *
   * Закрыт тем же секретом: перепись доступности наших источников — не то,
   * что стоит отдавать кому угодно.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/selftest') {
      return new Response('safety-relay: только /selftest', { status: 404 });
    }
    const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!env.CRON_SECRET || given !== env.CRON_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }
    const { body, census } = await collect();
    return new Response(JSON.stringify({
      census,
      would_post: Object.keys(TG_REQUIRED).every(f => Boolean(body[f])),
    }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  },
};
