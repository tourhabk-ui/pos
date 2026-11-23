/**
 * Шаг cron-llm-budget.yml: зелёная галочка только у настоящего замера.
 *
 * Пропуск аренды (skipped: lease_held) — HTTP 200, чтобы супервизор start.js
 * не записал ошибку, но это не замер расхода. В сводке — предупреждение и
 * SKIP, не OK. Аренду и тело ответа роут не меняет.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function llmBudgetVerdict(http, bodyText) {
  let body = null;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  if (body && body.skipped === 'lease_held') {
    return {
      exitCode: 0,
      measured: false,
      lines: [
        '::warning::Замер бюджета пропущен: окно часа занято другим планировщиком (lease_held). Это не замер расхода.',
        'SKIP lease_held',
      ],
    };
  }
  const lines = [];
  if (body && body.status === 'not_configured') {
    lines.push('::warning::Дневной бюджет AI не сторожится: AI_DAILY_BUDGET_USD не задан или не число на проде (переменные приложения Timeweb)');
  }
  if (http === 200) {
    lines.push('OK');
    return { exitCode: 0, measured: !(body && body.status === 'not_configured'), lines };
  }
  const shown = http === 0 ? '000' : String(http);
  lines.push(`FAIL ${shown}`);
  return { exitCode: 1, measured: false, lines };
}

function main() {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    console.log('::error::CRON_SECRET не задан в секретах репозитория — эндпоинт не вызван, прогон не состоялся');
    return 1;
  }
  const out = '/tmp/out.json';
  const res = spawnSync('curl', [
    '-sS', '-o', out, '-w', '%{http_code}', '--max-time', '30',
    '-H', `Authorization: Bearer ${secret}`,
    'https://vedarai.ru/api/cron/llm-budget-check',
  ], { encoding: 'utf8' });
  const raw = (res.stdout || '').trim();
  const http = /^\d{3}$/.test(raw) ? Number(raw) : 0;
  let body = '';
  try { body = readFileSync(out, 'utf8'); } catch { body = ''; }
  console.log(`HTTP: ${http === 0 ? '000' : http}`);
  if (body) console.log(body);
  const verdict = llmBudgetVerdict(http, body);
  for (const line of verdict.lines) console.log(line);
  return verdict.exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main());
