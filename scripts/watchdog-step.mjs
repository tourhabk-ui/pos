/**
 * Шаг cron-watchdog.yml: вторая нога следит за самим сторожем.
 *
 * Аудит агентов 23.11:
 *  - шаг проверял только HTTP 200. Сторож, собравший тревогу и не сумевший
 *    её отправить, отвечал 200 — и за ним не следил никто;
 *  - шаг печатал тело ответа целиком. Репозиторий публичный, а в теле —
 *    тексты тревог: координаты из SOS, названия компаний. Теперь в лог идёт
 *    только сводка: числа, имена проверок, исход доставки.
 *
 * Красный шаг — независимый от Telegram сигнал: о нём сообщает GitHub.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Запись о прогоне старше этого при занятом окне — держатель окна мог упасть. */
export const LAST_RUN_STALE_MIN = 90;

const short = (v) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 160);

export function watchdogStepVerdict(http, bodyText) {
  if (http !== 200) {
    return { exitCode: 1, lines: [`FAIL ${http === 0 ? '000' : http}`] };
  }
  let body = null;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return { exitCode: 1, lines: ['::error::Сторож ответил 200, но тело не разобрано — исход прогона неизвестен'] };
  }

  if (body.skipped === 'lease_held') {
    const last = body.last_run;
    if (!last || last.unread) {
      return { exitCode: 0, lines: ['::warning::Окно сторожа занято, а последний прогон не прочитан — состояние сторожа неизвестно', 'SKIP lease_held'] };
    }
    if (last.never) {
      return { exitCode: 0, lines: ['::warning::Окно сторожа занято, но в журнале нет ни одного прогона', 'SKIP lease_held'] };
    }
    if (last.delivery === 'failed') {
      return { exitCode: 1, lines: [`::error::Сторож собрал тревогу, но до владельца она не дошла (${last.age_min} мин назад): ${short(last.reason)}`] };
    }
    // Сторож упал с исключением: запись «failed» без исхода доставки (её пишет
    // catch роута). Держатель окна зовёт сторожа каждые полчаса, запись всегда
    // свежая — без этой ветки постоянно падающий сторож оставался зелёным на
    // единственном внешнем наблюдателе (ревью #3766). Текст ошибки не печатаем.
    if (last.status === 'failed') {
      return { exitCode: 1, lines: [`::error::Последний прогон сторожа упал (${last.age_min} мин назад) — проверки не выполнялись`] };
    }
    if (typeof last.age_min === 'number' && last.age_min > LAST_RUN_STALE_MIN) {
      return { exitCode: 1, lines: [`::error::Окно сторожа занято, а записи о прогоне нет ${last.age_min} мин — держатель окна мог упасть, платформу сейчас никто не сторожит`] };
    }
    return { exitCode: 0, lines: [`SKIP lease_held — последний прогон: ${short(last.status)}, ${last.age_min} мин назад, тревога: ${short(last.delivery ?? 'не записано')}`] };
  }

  const delivery = body.delivery && typeof body.delivery === 'object' ? body.delivery : {};
  const failedChecks = Array.isArray(body.checks?.failed) ? body.checks.failed.map((f) => short(f?.check)) : [];
  const alerts = Array.isArray(body.alerts) ? body.alerts.length : null;
  const lines = [];
  if (failedChecks.length > 0) lines.push(`::warning::Не выполнились проверки сторожа: ${failedChecks.join(', ')}`);
  if (delivery.status === 'failed') {
    lines.push(`::error::Сторож собрал тревогу, но до владельца она не дошла: ${short(delivery.reason)}`);
    return { exitCode: 1, lines };
  }
  lines.push(`OK — проверок ${body.checks?.total ?? '?'}, не выполнилось ${failedChecks.length}, тревог ${alerts ?? '?'}, доставка: ${short(delivery.status ?? 'не записано')}`);
  return { exitCode: 0, lines };
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : '';
  return v && !v.startsWith('--') ? v : fallback;
}

function main() {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    console.log('::error::CRON_SECRET не задан в секретах репозитория — эндпоинт не вызван, прогон не состоялся');
    return 1;
  }
  // Адрес и --max-time остаются в yaml: сторож второй ноги читает их оттуда.
  const url = argValue('--url', 'https://vedarai.ru/api/cron/watchdog');
  const maxTime = argValue('--max-time', '120');
  const out = '/tmp/watchdog-out.json';
  const res = spawnSync('curl', [
    '-sS', '-o', out, '-w', '%{http_code}', '--max-time', maxTime,
    '-H', `Authorization: Bearer ${secret}`,
    url,
  ], { encoding: 'utf8' });
  const raw = (res.stdout || '').trim();
  const http = /^\d{3}$/.test(raw) ? Number(raw) : 0;
  let body = '';
  try { body = readFileSync(out, 'utf8'); } catch { body = ''; }
  console.log(`HTTP: ${http === 0 ? '000' : http}`);
  // Тело НЕ печатаем: в нём тексты тревог, а лог Actions публичный.
  const verdict = watchdogStepVerdict(http, body);
  for (const line of verdict.lines) console.log(line);
  return verdict.exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main());
