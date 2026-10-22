/**
 * GET /api/cron/max-webhook  (Authorization: Bearer <CRON_SECRET> или ?secret=)
 *
 * Самолечение MAX-бота Кузьмича. Бот в MAX получает апдейты ТОЛЬКО через webhook-
 * подписку в MAX (POST /api/max/kuzmich). Если подписка теряется (смена домена,
 * вывод из эксплуатации старого хоста platform-api.max.ru, авто-снятие подписки
 * после серии ошибок) — бот молча замолкает и никто об этом не узнаёт.
 *
 * Этот крон детерминированно ПРОВЕРЯЕТ, что наш webhook-URL присутствует в списке
 * подписок MAX, и если его нет — регистрирует заново. Прогоняется по расписанию
 * (крон-воркфлоу) и вручную (workflow_dispatch), чтобы поднять бота немедленно.
 *
 * Идемпотентно: если подписка уже на месте — ничего не меняет.
 *
 * Регистрация и снятие засчитываются по ответу MAX целиком (HTTP-код и поле
 * `success`, `lib/max/subscription-response`), а после любой правки — по
 * повторному списку подписок: снятая, но оставшаяся — отказ; ожидаемой нет —
 * ставится сразу, и прогон красный. Без сверки крон отчитывался бы «снята» при
 * `{success:false}` с HTTP 200, а снятие, задевшее ожидаемый адрес, оставило бы
 * бота немым до следующего прогона через 6 ч при зелёном отчёте.
 * Env: MAX_BOT_TOKEN, CRON_SECRET.
 */

import { maxFetch } from '@/lib/max/max-fetch';
import { NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { maxWebhookUrl, redactWebhookUrl } from '@/lib/max/webhook-url';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { type MaxActionOutcome, readMaxAction, scrubMaxReason } from '@/lib/max/subscription-response';

export const dynamic = 'force-dynamic';

// MAX Bot API v2 — старый platform-api.max.ru выведен из эксплуатации.
const MAX_API_BASE = 'https://platform-api2.max.ru';
const UPDATE_TYPES = ['bot_started', 'message_created', 'message_callback'];

interface MaxSubscription { url?: string }

/**
 * Причина сетевого отказа. 223 прогона подряд писали только «fetch failed», и
 * что это сертификат, а не сеть, выяснилось лишь чтением цепочки руками.
 */
function causeOf(err: unknown): string | null {
  const c = err instanceof Error ? (err as Error & { cause?: unknown }).cause : null;
  if (!c) return null;
  const code = typeof c === 'object' && c !== null && 'code' in c ? String((c as { code: unknown }).code) : '';
  const msg = c instanceof Error ? c.message : String(c);
  return [code, msg].filter(Boolean).join(': ').slice(0, 200);
}

/** Отказ словами для ответа и лога: сообщение и причина цепочки, без ключа. */
function failureText(err: unknown): string {
  return scrubMaxReason([err instanceof Error ? err.message : String(err), causeOf(err)].filter(Boolean).join('; '));
}

// URL с webhook-секретом (если задан MAX_WEBHOOK_SECRET) — см. lib/max/webhook-url.
function expectedWebhookUrl(): string {
  return maxWebhookUrl();
}

/**
 * Хосты, на которых живёт этот же сайт: хост адреса подписки, канон
 * vedarai.ru и прежний tourhab.ru (с www). tourhab.ru отдаёт /api того же
 * приложения без переадресации (next.config.js, «Канон домена»), а прежняя
 * подписка при старте контейнера брала его запасным хостом — без ключа.
 */
const OWN_HOSTS = ['vedarai.ru', 'www.vedarai.ru', 'tourhab.ru', 'www.tourhab.ru'];
const WEBHOOK_PATH = '/api/max/kuzmich';

function parsedUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch (err) {
    // Неразборчивый адрес — не наш: снимать его нечем доказать.
    console.warn('[cron/max-webhook] адрес подписки не разобран:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Наш ли хост: канон, прежний tourhab.ru (с www) или хост адреса подписки. */
function isOwnHost(hostname: string, webhookUrl: string): boolean {
  const own = new Set(OWN_HOSTS);
  const expectedHost = parsedUrl(webhookUrl)?.hostname;
  if (expectedHost) own.add(expectedHost.toLowerCase());
  return own.has(hostname.toLowerCase());
}

/** Наш ли это адрес вебхука: наш хост и путь вебхука, ключ — любой или никакой. */
function isOwnWebhookUrl(url: string, webhookUrl: string): boolean {
  const u = parsedUrl(url);
  if (!u) return false;
  return isOwnHost(u.hostname, webhookUrl) && u.pathname.replace(/\/+$/, '') === WEBHOOK_PATH;
}

/** Сегмент пути, который можно показать: слова из строчных латинских букв через - или _. */
const WORD_SEGMENT = /^[a-z]+(?:[-_][a-z]+)*$/;

/**
 * Подписка для ответа крона. Ответ печатается в лог GitHub Actions
 * (`cron-max-webhook.yml`, `cat /tmp/out.json`), а в чужом адресе ключ бывает
 * не только в query, но и в пути (`hook.example/abcd1234secret`). Поэтому:
 * хост — всегда; путь чужого хоста — только если это путь вебхука Кузьмича
 * (он и так публичен), иначе «путь скрыт»; путь нашего хоста — по сегментам,
 * всё, что не похоже на слово, скрыто; query — никогда, что он был, сказано.
 */
function describeSubscription(url: string, webhookUrl: string): string {
  const u = parsedUrl(url);
  if (!u) return 'адрес не разобран';
  const path = u.pathname.replace(/\/+$/, '');
  const ownHost = isOwnHost(u.hostname, webhookUrl);
  let shown = '';
  let pathHidden = false;
  if (path === WEBHOOK_PATH) {
    shown = path;
  } else if (path !== '' && ownHost) {
    shown = path.split('/').map((seg) => (seg === '' || (seg.length <= 16 && WORD_SEGMENT.test(seg)) ? seg : '[скрыто]')).join('/');
  } else if (path !== '') {
    pathHidden = true;
  }
  const queryHidden = u.search !== '';
  const note = pathHidden && queryHidden ? ' (путь и параметры скрыты)'
    : pathHidden ? ' (путь скрыт)'
      : queryHidden ? ' (параметры скрыты)'
        : '';
  return `${u.host.toLowerCase()}${shown}${note}`;
}

/** Снятие, которое не подтвердилось: адрес без ключа и причина словами. */
interface StaleFailure { url: string; reason: string }

/**
 * Снять НАШИ старые подписки: путь /api/max/kuzmich на любом из наших хостов,
 * но не тот адрес, что ждём (обычно — без секрета, заведённый до
 * MAX_WEBHOOK_SECRET или прежним стартом контейнера на tourhab.ru). Без этого
 * MAX шлёт каждое сообщение на оба адреса: незаверенную копию вебхук при
 * заданном ключе отбрасывает, но она по-прежнему тратит запрос на каждый
 * апдейт. Чужие адреса не трогаем, их показываем (`describeSubscription`).
 * Зовётся только когда ожидаемый адрес уже точно зарегистрирован — иначе
 * бот остался бы без подписки вовсе.
 *
 * Снятие засчитывается по ответу MAX (`readMaxAction`: HTTP-код и `success`),
 * а окончательно — по повторному списку в GET ниже. Отказ называет причину:
 * код сети, HTTP-код, `message` MAX.
 */
async function removeStale(
  current: MaxSubscription[],
  webhookUrl: string,
  headers: Record<string, string>,
): Promise<{ removed: string[]; failed: StaleFailure[]; others: string[]; attempted: number }> {
  const urls = current.map((s) => s.url ?? '').filter((u) => u !== webhookUrl);
  const stale = urls.filter((u) => isOwnWebhookUrl(u, webhookUrl));
  const others = urls.filter((u) => !isOwnWebhookUrl(u, webhookUrl)).map((u) => describeSubscription(u, webhookUrl));
  const removed: string[] = [];
  const failed: StaleFailure[] = [];
  for (const url of stale) {
    let reason: string;
    try {
      const res = await maxFetch(`${MAX_API_BASE}/subscriptions?url=${encodeURIComponent(url)}`, { method: 'DELETE', headers });
      const outcome = await readMaxAction(res);
      if (outcome.ok) {
        removed.push(url);
        continue;
      }
      reason = outcome.reason;
    } catch (err) {
      reason = failureText(err);
    }
    console.error(`[cron/max-webhook] старая подписка ${redactWebhookUrl(url)} не снята: ${reason}`);
    failed.push({ url: redactWebhookUrl(url), reason });
  }
  return { removed, failed, others, attempted: stale.length };
}

/** Список подписок MAX; отказ — с причиной, без ключа. */
async function listSubscriptions(
  headers: Record<string, string>,
): Promise<{ ok: true; list: MaxSubscription[] } | { ok: false; reason: string }> {
  try {
    const res = await maxFetch(`${MAX_API_BASE}/subscriptions`, { method: 'GET', headers });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data: unknown = await res.json();
    const raw = Array.isArray(data) ? data : (data as { subscriptions?: unknown } | null)?.subscriptions;
    if (!Array.isArray(raw)) return { ok: false, reason: 'в ответе нет списка подписок' };
    return { ok: true, list: raw as MaxSubscription[] };
  } catch (err) {
    return { ok: false, reason: failureText(err) };
  }
}

/** Поставить подписку на ожидаемый адрес; исход — по ответу MAX. */
async function register(webhookUrl: string, headers: Record<string, string>): Promise<{ status: number; outcome: MaxActionOutcome }> {
  const res = await maxFetch(`${MAX_API_BASE}/subscriptions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: webhookUrl, update_types: UPDATE_TYPES }),
  });
  return { status: res.status, outcome: await readMaxAction(res) };
}

export async function GET(req: Request): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(req) ?? '', cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Отметка прогона в agent_run_history под ключом реестра 'max-webhook'
  // (аудит 15.10, P4-07). Крон был немым: бот в MAX однажды уже молчал месяц
  // без сигнала, а «перестал запускаться» сам сторож подписки не видел никто.
  // Каждый ответ после проверки секрета проходит через finish: 200 — успех,
  // всё прочее — отказ с причиной. Адрес вебхука в причину не попадает — в
  // нём секрет.
  const t0 = Date.now();
  const finish = (body: Record<string, unknown>, status = 200): NextResponse => {
    if (status === 200) {
      recordCronRun('max-webhook', t0, 'success');
    } else {
      const staleFailed = Array.isArray(body.stale_failed) ? (body.stale_failed as StaleFailure[]) : [];
      const why = [
        body.step, body.action, body.error, body.cause, body.status,
        staleFailed.length > 0 ? `не сняты старые подписки: ${staleFailed.length} (${staleFailed[0]!.reason})` : undefined,
      ]
        .filter((x) => x !== undefined && x !== null && x !== '')
        .map(String)
        .join(': ');
      recordCronRun('max-webhook', t0, 'failed', { error: (why || `HTTP ${status}`).slice(0, 300) });
    }
    return NextResponse.json(body, { status });
  };

  const token = process.env.MAX_BOT_TOKEN;
  if (!token) {
    return finish({ error: 'MAX_BOT_TOKEN not set' }, 500);
  }

  const headers = { 'Content-Type': 'application/json', Authorization: token };
  const webhookUrl = expectedWebhookUrl();

  // 1. Что сейчас зарегистрировано в MAX
  let current: MaxSubscription[] = [];
  let listOk = false;
  try {
    const res = await maxFetch(`${MAX_API_BASE}/subscriptions`, { method: 'GET', headers });
    listOk = res.ok;
    const data = await res.json().catch(() => ({}));
    // MAX может вернуть { subscriptions: [...] } или массив
    const raw = Array.isArray(data) ? data : (data?.subscriptions ?? []);
    if (Array.isArray(raw)) current = raw as MaxSubscription[];
  } catch (err) {
    return finish(
      { ok: false, step: 'list', error: err instanceof Error ? err.message : 'fetch failed', cause: causeOf(err) },
      502,
    );
  }

  const alreadyRegistered = current.some(s => s.url === webhookUrl);

  // 2. Подписки нет — регистрируем заново (самолечение). Засчитывается по
  //    ответу MAX: `success: false` при HTTP 200 — отказ, а не «поставлена».
  let registerStatus = 0;
  if (!alreadyRegistered) {
    try {
      const reg = await register(webhookUrl, headers);
      registerStatus = reg.status;
      if (!reg.outcome.ok) {
        return finish(
          { ok: false, action: 'register_failed', error: reg.outcome.reason, webhook_url: redactWebhookUrl(webhookUrl) },
          502,
        );
      }
    } catch (err) {
      return finish(
        { ok: false, step: 'register', error: err instanceof Error ? scrubMaxReason(err.message) : 'fetch failed', cause: causeOf(err) },
        502,
      );
    }
  }

  // 3. Снять наши старые подписки — только когда ожидаемая уже стоит.
  const stale = await removeStale(current, webhookUrl, headers);
  const action = !alreadyRegistered ? 'registered' : stale.removed.length > 0 ? 'removed_stale' : 'noop';
  const base = {
    action,
    ...(alreadyRegistered ? {} : { reason: listOk ? 'subscription_missing' : 'list_unavailable', register_status: registerStatus }),
    webhook_url: redactWebhookUrl(webhookUrl),
    update_types: UPDATE_TYPES,
    subscriptions: current.length,
    other_subscriptions: stale.others,
  };

  // Ничего не меняли — проверять нечего: список только что прочитан.
  if (alreadyRegistered && stale.attempted === 0) {
    return finish({ ok: true, ...base, stale_removed: [], stale_failed: [] });
  }

  // 4. Сверка повторным списком. Ответ MAX на POST/DELETE — его слово, а не
  //    состояние: снятая подписка может остаться, а снятие по `?url=` — задеть
  //    больше, чем этот адрес. Ожидаемой нет — ставим сразу, не дожидаясь
  //    следующего прогона через 6 ч: без неё бот в MAX молчит.
  const after = await listSubscriptions(headers);
  if (!after.ok) {
    return finish({
      ok: false, ...base, step: 'verify', error: `список после правки не прочитан — исход не проверен: ${after.reason}`,
      stale_removed: stale.removed.map(redactWebhookUrl), stale_failed: stale.failed,
    }, 502);
  }
  const afterUrls = new Set(after.list.map((s) => s.url ?? ''));
  const stillThere = stale.removed.filter((u) => afterUrls.has(u));
  const removed = stale.removed.filter((u) => !afterUrls.has(u)).map(redactWebhookUrl);
  const failed: StaleFailure[] = [
    ...stale.failed,
    ...stillThere.map((u) => ({ url: redactWebhookUrl(u), reason: 'MAX ответил «снята», а подписка осталась в списке' })),
  ];
  for (const f of failed.slice(stale.failed.length)) {
    console.error(`[cron/max-webhook] старая подписка ${f.url} не снята: ${f.reason}`);
  }
  const verified = { stale_removed: removed, stale_failed: failed, subscriptions_after: after.list.length };

  if (!afterUrls.has(webhookUrl)) {
    let reregister: string;
    try {
      const reg = await register(webhookUrl, headers);
      reregister = reg.outcome.ok ? 'поставлена заново' : `не поставлена: ${reg.outcome.reason}`;
    } catch (err) {
      reregister = `не поставлена: ${failureText(err)}`;
    }
    console.error(`[cron/max-webhook] ожидаемой подписки ${redactWebhookUrl(webhookUrl)} нет в списке после правки — ${reregister}`);
    return finish({
      ok: false, ...base, ...verified,
      error: `ожидаемой подписки нет в списке после правки; ${reregister}`,
    }, 502);
  }

  return finish({ ok: failed.length === 0, ...base, ...verified }, failed.length === 0 ? 200 : 502);
}
