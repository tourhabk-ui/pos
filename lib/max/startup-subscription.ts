/**
 * lib/max/startup-subscription.ts — подписка бота MAX при старте контейнера.
 *
 * До 22.10 `instrumentation.ts` подписывал адрес БЕЗ ключа
 * (`${NEXT_PUBLIC_BASE_URL ?? 'https://tourhab.ru'}/api/max/kuzmich`) обычным
 * `fetch` и глушил отказ пустым `catch`. Обычный `fetch` не знает корня
 * Минцифры, которым подписан API MAX (`lib/max/max-fetch`), поэтому на проде
 * он, по всей видимости, падал на TLS молча и ничего не подписывал. Если бы
 * дошёл — завёл бы вторую подписку, апдейты которой не заверены: нажатия
 * кнопок с неё не проверить, а человек получал бы второй ответ.
 *
 * Теперь адрес один на старт, крон и админку — `maxWebhookUrl()` с ключом,
 * путь — `maxFetch`, отказ — в лог с замаскированным адресом
 * (`redactWebhookUrl`): лог контейнера читают люди, ключ в нём — утечка.
 *
 * Без `MAX_WEBHOOK_SECRET` старт НЕ подписывает ничего. Адрес без ключа
 * делает каждый апдейт незаверенным: вход, подключение чатов, ответы на
 * запросы мест и кнопки лида тогда не работают вовсе
 * (`lib/max/verified-press`). Сказать об этом в лог честнее, чем молча
 * подписать адрес, с которого ни одно нажатие не проверить. Чинить и снимать
 * лишние подписки — дело крона `/api/cron/max-webhook` (раз в 6 ч); старт
 * только не даёт боту остаться без подписки после выката.
 *
 * Подписка засчитывается по ответу MAX целиком: `{success:false}` приходит и с
 * HTTP 200 (`lib/max/subscription-response`). Отказ старта — не строка в логе,
 * которую никто не читает: при заданном ключе вебхук отбрасывает запросы без
 * него (`app/api/max/kuzmich`), и после смены ключа без новой подписки бот в
 * MAX молчит полностью — туристам, операторам, контролю выхода — до прогона
 * крона, до 6 ч. Поэтому `subscribeMaxOnStart` повторяет попытку с паузами
 * (`RETRY_DELAYS_MS`) и, если не вышло, шлёт тревогу в рабочий чат
 * (`tgSend`) с тем, как поднять бота сразу.
 */

import { maxFetch } from '@/lib/max/max-fetch';
import { maxWebhookUrl, redactWebhookUrl } from '@/lib/max/webhook-url';
import { readMaxAction } from '@/lib/max/subscription-response';
import { tgSend, type TgSendOutcome } from '@/lib/notifications/tg-send';

const MAX_API_BASE = 'https://platform-api2.max.ru';
const UPDATE_TYPES = ['bot_started', 'message_created', 'message_callback'];

export type StartupSubscriptionOutcome =
  | { outcome: 'skipped'; reason: 'no_token' | 'no_key' }
  | { outcome: 'present' }
  | { outcome: 'registered' }
  | { outcome: 'failed'; step: 'list' | 'register'; reason: string };

/** Причина отказа без адреса: в сообщении сети бывает URL, а в нём ключ. */
function reasonOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : null;
  const causeCode = typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : '';
  const msg = err instanceof Error ? err.message : String(err);
  return redactWebhookUrl([code || causeCode, msg].filter(Boolean).join(': ')).slice(0, 200);
}

export async function ensureMaxSubscriptionOnStart(): Promise<StartupSubscriptionOutcome> {
  const token = process.env.MAX_BOT_TOKEN;
  if (!token) return { outcome: 'skipped', reason: 'no_token' };

  if (!process.env.MAX_WEBHOOK_SECRET) {
    console.error('[max] подписка при старте не ставится: MAX_WEBHOOK_SECRET не задан. '
      + 'Без него ни одно нажатие в MAX не проверить — вход, подключение чатов, ответы на запросы мест и кнопки лида не работают.');
    return { outcome: 'skipped', reason: 'no_key' };
  }

  const url = maxWebhookUrl();
  const shown = redactWebhookUrl(url);
  const headers = { 'Content-Type': 'application/json', Authorization: token };

  let present = false;
  try {
    const res = await maxFetch(`${MAX_API_BASE}/subscriptions`, { method: 'GET', headers });
    if (!res.ok) {
      console.error(`[max] подписки при старте не прочитаны: HTTP ${res.status}; адрес ${shown} не проверен`);
      return { outcome: 'failed', step: 'list', reason: `HTTP ${res.status}` };
    }
    const data: unknown = await res.json();
    const raw = Array.isArray(data) ? data : (data as { subscriptions?: unknown } | null)?.subscriptions;
    const list = Array.isArray(raw) ? raw : [];
    present = list.some((s) => typeof s === 'object' && s !== null && (s as { url?: unknown }).url === url);
  } catch (err) {
    const reason = reasonOf(err);
    console.error(`[max] подписки при старте не прочитаны: ${reason}; адрес ${shown} не проверен`);
    return { outcome: 'failed', step: 'list', reason };
  }

  if (present) return { outcome: 'present' };

  try {
    const res = await maxFetch(`${MAX_API_BASE}/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, update_types: UPDATE_TYPES }),
    });
    const action = await readMaxAction(res);
    if (!action.ok) {
      console.error(`[max] подписка ${shown} при старте не поставлена: ${action.reason}`);
      return { outcome: 'failed', step: 'register', reason: action.reason };
    }
    return { outcome: 'registered' };
  } catch (err) {
    const reason = reasonOf(err);
    console.error(`[max] подписка ${shown} при старте не поставлена: ${reason}`);
    return { outcome: 'failed', step: 'register', reason };
  }
}

/**
 * Паузы перед повторами: полминуты, две и десять минут. Отказ на старте чаще
 * всего — сеть или 5xx/429 MAX в первые секунды после выката; десять минут
 * последней паузы — ещё в пределах одной смены, а не шести часов крона.
 */
export const RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

function escHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Текст тревоги: без адреса и ключа, с тем, как поднять бота сразу. */
export function startupAlertText(out: Extract<StartupSubscriptionOutcome, { outcome: 'failed' }>, attempts: number): string {
  const what = out.step === 'list'
    ? 'подписки MAX не прочитаны — стоит ли подписка с текущим ключом, не проверено'
    : 'подписка с текущим ключом не поставлена';
  return [
    '<b>Бот MAX: подписка при старте не удалась</b>',
    '',
    `Попыток: ${attempts}; ${what}.`,
    `<b>Причина:</b> ${escHtml(out.reason)}`,
    '',
    'Пока подписки с текущим ключом нет, MAX зовёт прежний адрес, а вебхук такие запросы отбрасывает: '
      + 'бот в MAX не отвечает никому — ни туристам, ни операторам, ни контролю выхода.',
    'Поднять сразу — запустить workflow cron-max-webhook вручную; сам он придёт в течение 6 ч.',
  ].join('\n');
}

/**
 * Подписка при старте с повторами и тревогой. Пропуск (нет токена или ключа)
 * не повторяется и не тревожит — это настройка, она названа в логе.
 */
export async function subscribeMaxOnStart(opts: {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  alert?: (text: string) => Promise<TgSendOutcome>;
} = {}): Promise<StartupSubscriptionOutcome> {
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const alert = opts.alert ?? ((text: string) => tgSend('max-startup-subscription', text));

  let out = await ensureMaxSubscriptionOnStart();
  let attempts = 1;
  for (const ms of delays) {
    if (out.outcome !== 'failed') return out;
    await sleep(ms);
    out = await ensureMaxSubscriptionOnStart();
    attempts += 1;
  }
  if (out.outcome !== 'failed') return out;

  const sent = await alert(startupAlertText(out, attempts));
  if (!sent.ok) {
    console.error(`[max] тревога о подписке при старте не доставлена: ${sent.reason}`);
  }
  return out;
}
