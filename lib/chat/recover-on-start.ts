/**
 * lib/chat/recover-on-start.ts — после старта сервера подобрать сообщения
 * Telegram, брошенные прежним запуском (#3433 п. 1, слово владельца 16.11
 * «Оба шага»).
 *
 * Telegram получает 200 до обработки и сам апдейт не повторит. Упал процесс
 * посередине — сообщение лежит в chat_inbound_seen (миграция 1449), и новый
 * запуск отдаёт его вебхуку: GET /api/telegram/webhook с CRON_SECRET. Вызов
 * идёт в свой же сервер, как у супервизора start.js: обработчик живёт в роуте,
 * и вынести его в библиотеку ради одного вызова — переписать вебхук.
 *
 * Ждёт 150 секунд: сервер должен успеть встать, а подбираются только
 * сообщения старше двух минут (INBOUND_CLAIM_MIN_AGE_SECONDS) — к этому
 * времени брошенное перед падением уже старше порога, а при выкате старый
 * процесс успевает ответить на своё. Без CRON_SECRET и вне
 * production не делает ничего и говорит об этом в лог. Исход — в лог: 200 с
 * числом подобранных, иначе код ответа.
 */
import http from 'node:http';

export const RECOVER_AFTER_MS = 150_000;
export const RECOVER_PATH = '/api/telegram/webhook';

type Requester = typeof http.request;

export function scheduleTelegramRecovery(opts: {
  env?: NodeJS.ProcessEnv;
  request?: Requester;
  schedule?: (fn: () => void, ms: number) => unknown;
} = {}): 'scheduled' | 'skipped' {
  const env = opts.env ?? process.env;
  const secret = env.CRON_SECRET;
  if (!secret) {
    console.error('[chat/recover] CRON_SECRET не задан — брошенные сообщения Telegram после перезапуска не подбираются');
    return 'skipped';
  }
  if (env.NODE_ENV !== 'production') return 'skipped';
  const port = Number(env.PORT) || 3000;
  const request = opts.request ?? http.request;
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  schedule(() => {
    const r = request({
      hostname: '127.0.0.1', port, path: RECOVER_PATH, method: 'GET',
      // server.js сверяет Host с HOSTNAME=127.0.0.1 (как у супервизора start.js).
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${secret}` },
      timeout: 60_000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { if (body.length < 500) body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[chat/recover] подбор брошенных сообщений Telegram: HTTP ${res.statusCode}`);
          return;
        }
        const recovered = /"recovered":(\d+)/.exec(body)?.[1];
        if (recovered && recovered !== '0') console.error(`[chat/recover] подобрано сообщений Telegram: ${recovered}`);
      });
    });
    r.on('timeout', () => { console.error('[chat/recover] подбор: нет ответа за 60 с'); r.destroy(); });
    r.on('error', (e: Error) => console.error('[chat/recover] подбор не выполнился:', e.message));
    r.end();
  }, RECOVER_AFTER_MS);
  return 'scheduled';
}
