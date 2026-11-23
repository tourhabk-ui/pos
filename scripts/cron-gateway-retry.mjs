/**
 * Повтор вызова крон-роута на vedarai.ru, когда ответил шлюз, а не роут.
 *
 * Прогоны 44954714899 (scout-digest, 21.11) и 43875975789 (kuzmich-eval, 16.11):
 * curl получил HTTP 502 с пустым телом за 18 и 40 секунд. Роут приложения
 * отвечает JSON (401 без секрета, 500 со своей ошибкой). Пустое тело — шлюз
 * или origin перед приложением. 401, 404 и 5xx самого роута не повторяем:
 * повтор заявки или эвала сжёг бы окно расхода второй раз.
 *
 * Скрипт без зависимостей: workflow зовёт его после checkout, тест импортирует
 * чистые функции и не ходит в сеть.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isGatewayStatus(status) {
  return status === 502 || status === 503 || status === 504 || status === 0;
}

/**
 * Повторять ли. `attempt` — номер уже сделанной попытки (1 — первая).
 * `fastOnlySec`: ответ дольше этого — не «сайт на секунду отвалился»,
 * повтор не делаем (у эвала первый вызов мог занять окно расхода).
 */
export function shouldRetryGateway({ status, elapsedSec, attempt, attempts, fastOnlySec }) {
  if (!isGatewayStatus(status)) return false;
  if (attempt >= attempts) return false;
  if (fastOnlySec != null && elapsedSec >= fastOnlySec) return false;
  return true;
}

/** Текст отказа для лога Actions. Пустое тело не называется «ошибкой роута». */
export function gatewayFailureNote({ url, status, body, elapsedSec }) {
  const empty = body.trim().length === 0;
  const code = status === 0 ? '000 (соединение оборвалось)' : String(status);
  const where = `${url} ответил HTTP ${code} за ${elapsedSec} с`;
  if (empty && isGatewayStatus(status)) {
    return (
      `${where} с пустым телом. Это шлюз или origin перед приложением: ` +
      'роут Ведара отвечает JSON (401 без секрета, 500 со своей ошибкой). Повтор не помог.'
    );
  }
  const snippet = body.trim().slice(0, 300).replace(/\s+/g, ' ');
  return `${where}. Тело: ${snippet || '(пусто)'}`;
}

function parseArgs(argv) {
  const out = { attempts: 3, pauses: [20, 40], fastOnlySec: null, method: 'GET', data: null, maxTime: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--url') out.url = next;
    else if (a === '--out' || a === '-o') out.out = next;
    else if (a === '--max-time') out.maxTime = Number(next);
    else if (a === '--method') out.method = next;
    else if (a === '--data') out.data = next;
    else if (a === '--attempts') out.attempts = Number(next);
    else if (a === '--pause') out.pauses = next.split(',').map((n) => Number(n));
    else if (a === '--fast-only') out.fastOnlySec = Number(next);
    else continue;
    i += 1;
  }
  return out;
}

export function curlArgs({ url, out, maxTime, method, data, secret }) {
  const args = ['-sS', '-o', out, '-w', '%{http_code}', '--max-time', String(maxTime), '-X', method, url,
    '-H', `Authorization: Bearer ${secret}`];
  if (data) args.push('-H', 'Content-Type: application/json', '--data-binary', `@${data}`);
  return args;
}

function curlOnce({ url, out, maxTime, method, data, secret }) {
  const args = curlArgs({ url, out, maxTime, method, data, secret });
  const started = Date.now();
  const res = spawnSync('curl', args, { encoding: 'utf8' });
  const elapsedSec = Math.max(0, Math.round((Date.now() - started) / 1000));
  const raw = (res.stdout || '').trim();
  const status = /^\d{3}$/.test(raw) ? Number(raw) : 0;
  let body = '';
  try { body = readFileSync(out, 'utf8'); } catch { body = ''; }
  return { status, body, elapsedSec, curlError: res.status !== 0 ? (res.stderr || '').trim() : '' };
}

function sleepSec(sec) {
  if (sec > 0) spawnSync('sleep', [String(sec)]);
}

export function runGatewayRetry(opts, curl = curlOnce, wait = sleepSec) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    console.log('::error::CRON_SECRET не задан в секретах репозитория — эндпоинт не вызван, прогон не состоялся');
    return 1;
  }
  if (!opts.url || !opts.out) {
    console.log('::error::нужны --url и --out');
    return 1;
  }
  let last = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    last = curl({ ...opts, secret });
    const shown = last.status === 0 ? '000' : String(last.status);
    console.log(`попытка ${attempt}: HTTP ${shown} за ${last.elapsedSec} с`);
    if (last.status === 200) return 0;
    if (!shouldRetryGateway({
      status: last.status,
      elapsedSec: last.elapsedSec,
      attempt,
      attempts: opts.attempts,
      fastOnlySec: opts.fastOnlySec,
    })) break;
    const pause = opts.pauses[Math.min(attempt - 1, opts.pauses.length - 1)] ?? 20;
    console.log(`шлюз HTTP ${shown} — повтор через ${pause} с`);
    wait(pause);
  }
  const note = gatewayFailureNote({
    url: opts.url,
    status: last?.status ?? 0,
    body: last?.body ?? '',
    elapsedSec: last?.elapsedSec ?? 0,
  });
  console.log(`::error::${note}`);
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const code = runGatewayRetry(parseArgs(process.argv.slice(2)));
  process.exit(code);
}
