/**
 * Server component — читает токен из env, вызывает Telegram API с сервера,
 * авто-регистрирует webhook, рендерит результат в HTML.
 * Не требует никаких действий от пользователя кроме открыть страницу.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySessionToken } from '@/lib/auth/jwt';
import { getSetting } from '@/lib/platform-settings';
import { canonicalWebhookUrl, setCanonicalWebhook } from '@/lib/telegram/operator-availability';

// Адрес вебхука ставит одна дверь — setCanonicalWebhook (аудит 15.10). Прежде
// страница ставила /api/telegram/kuzmich без секрета и от NEXT_PUBLIC_APP_URL,
// а на Timeweb это внутренний *.twc1.net, который Telegram не резолвит.

async function getToken(): Promise<string> {
  return (
    process.env.TELEGRAM_BOT_TOKEN ??
    (await getSetting('telegram_bot_token').catch(() => null)) ??
    ''
  );
}

async function tg(token: string, method: string, body?: unknown) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    return res.json();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export default async function TelegramWebhookPage() {
  const cookieStore = await cookies();
  const authToken = cookieStore.get('auth_token')?.value;
  // Подпись И живая строка сессии (аудит 15.10, P3-01). Страница при рендере
  // сама зовёт setWebhook с drop_pending_updates — по одной подписи это мог
  // сделать токен вышедшего админа ещё до 7 дней. Edge-middleware базы не
  // видит, так что отзыв проверяется только здесь. Не смогли сверить — не
  // пускаем (§4.0: для своей страницы «не знаю» блокирует), причина в логе.
  const session = authToken ? await verifySessionToken(authToken) : null;
  const user = session?.status === 'valid' ? session.payload : null;
  if (!user || user.role !== 'admin') redirect('/auth/login?from=/hub/admin/telegram/webhook');

  const token = await getToken();
  const webhookUrl = canonicalWebhookUrl();

  if (!token) {
    return (
      <div className="ds-page max-w-2xl mx-auto py-8 space-y-4">
        <h1 className="ds-h1">Webhook диагностика</h1>
        <div className="ds-card p-5 bg-[var(--danger)]/10 text-[var(--danger)]">
          TELEGRAM_BOT_TOKEN не задан в Timeweb
        </div>
      </div>
    );
  }

  const me       = await tg(token, 'getMe');
  const before   = await tg(token, 'getWebhookInfo');
  const curUrl   = before?.result?.url ?? '';
  const needsFix = curUrl !== webhookUrl;

  const setResult = needsFix ? await setCanonicalWebhook(token) : null;

  const after = needsFix ? await tg(token, 'getWebhookInfo') : before;

  const w = after?.result ?? {};
  const ok = w.url === webhookUrl && !w.last_error_message;

  return (
    <div className="ds-page max-w-2xl mx-auto py-8 space-y-4">
      <h1 className="ds-h1">Webhook диагностика</h1>

      <div className={`ds-card p-5 text-sm space-y-2 ${ok ? 'bg-[var(--success)]/10' : 'bg-[var(--warning)]/10'}`}>
        <div className="font-bold text-base">
          {ok ? '✓ Webhook работает' : '⚠ Webhook требует внимания'}
        </div>
        <div>Бот: @{me?.result?.username} — {me?.result?.first_name}</div>
        <div>Токен: …{token.slice(-6)}</div>
      </div>

      <div className="ds-card p-5 space-y-3">
        <div className="ds-label">getWebhookInfo (после авто-фикса)</div>
        <pre className="text-xs bg-[var(--bg-primary)] p-3 rounded overflow-auto">
          {JSON.stringify(after, null, 2)}
        </pre>
      </div>

      {needsFix && (
        <div className="ds-card p-5 space-y-3">
          <div className="ds-label">setWebhook результат</div>
          <pre className="text-xs bg-[var(--bg-primary)] p-3 rounded overflow-auto">
            {JSON.stringify(setResult, null, 2)}
          </pre>
        </div>
      )}

      <div className="ds-card p-5">
        <div className="ds-label">getWebhookInfo (до фикса)</div>
        <pre className="text-xs bg-[var(--bg-primary)] p-3 rounded overflow-auto">
          {JSON.stringify(before, null, 2)}
        </pre>
      </div>
    </div>
  );
}
