#!/usr/bin/env node
/**
 * Evo — рука действия: заведение GitHub Issues из находок Growth Scan.
 *
 * Читает готовые (title/body) находки в статусе 'suggested' с прода
 * (/api/cron/evo-report), заводит по каждой GitHub Issue через `gh`, затем
 * POST-колбэком проставляет github_issue_url, чтобы следующий прогон не
 * дублировал. Дедуп второй линии: перед созданием ищем открытую issue с тем
 * же заголовком (колбэк мог не пройти в прошлый раз) — тогда переиспользуем.
 *
 * Раннер на GitHub Actions (не на Timeweb) → RF-блокировки не мешают gh/API.
 * Никаких изменений кода: только заведение задач в трекер — безопасно, обратимо.
 * Требует: gh (авторизован через GH_TOKEN), CRON_SECRET.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROD_URL = process.env.TOURHAB_URL || 'https://vedarai.ru';
const CRON_SECRET = process.env.CRON_SECRET || '';
const REPO = process.env.EVO_REPO || 'tourhabk-ui/pos';
const LABEL = 'evo';

function log(stage, message, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage, message, ...data }));
}

async function fetchReportable() {
  const res = await fetch(`${PROD_URL}/api/cron/evo-report`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET evo-report → HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.issues) ? data.issues : [];
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...opts }).trim();
}

// Уже есть открытая issue с таким заголовком? (колбэк мог не пройти ранее).
// Возвращает URL или null.
function findExistingIssue(title) {
  try {
    const out = gh([
      'issue', 'list', '--repo', REPO, '--state', 'open',
      '--search', `${title} in:title`, '--json', 'title,url', '--limit', '20',
    ]);
    const list = JSON.parse(out || '[]');
    const hit = list.find((i) => i.title === title);
    return hit ? hit.url : null;
  } catch (e) {
    log('WARN', 'поиск дубля не удался (продолжаем на создание)', { error: String(e) });
    return null;
  }
}

function ensureLabel() {
  try {
    gh(['label', 'create', LABEL, '--repo', REPO, '--color', 'B4761F',
      '--description', 'Заведено рукой эволюции (Evo Growth Scan)', '--force']);
  } catch (e) {
    log('WARN', 'не удалось создать/обновить метку (не критично)', { error: String(e) });
  }
}

function createIssue(title, body) {
  const tmp = path.join(os.tmpdir(), `evo-issue-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmp, body);
  try {
    return gh(['issue', 'create', '--repo', REPO, '--title', title, '--body-file', tmp, '--label', LABEL]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function callback(reported) {
  if (reported.length === 0) return;
  const res = await fetch(`${PROD_URL}/api/cron/evo-report`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CRON_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reported }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`POST evo-report → HTTP ${res.status}`);
  const data = await res.json();
  log('CALLBACK', 'помечено вынесенным', { updated: data.updated });
}

async function main() {
  if (!CRON_SECRET) { log('ERROR', 'CRON_SECRET не задан'); process.exit(1); }

  let findings;
  try {
    findings = await fetchReportable();
  } catch (e) {
    // Эндпоинт мог быть ещё не задеплоен (окно Timeweb) — не краснить job.
    log('WARN', 'не удалось получить находки — пустой прогон', { error: String(e) });
    return;
  }

  log('EVO_REPORT', `находок к выносу: ${findings.length}`);
  if (findings.length === 0) return;

  ensureLabel();

  const reported = [];
  for (const f of findings) {
    try {
      const existing = findExistingIssue(f.title);
      const url = existing || createIssue(f.title, f.body);
      reported.push({ id: f.id, issue_url: url });
      log(existing ? 'DEDUP' : 'CREATE', f.title, { url });
    } catch (e) {
      log('ERROR', 'не удалось завести issue', { id: f.id, error: String(e) });
    }
  }

  try {
    await callback(reported);
  } catch (e) {
    // Не критично: непомеченные вынесутся снова, но дедуп по заголовку не даст дубля.
    log('WARN', 'колбэк не прошёл (следующий прогон дедупит по заголовку)', { error: String(e) });
  }

  log('EVO_REPORT', `готово: заведено/переиспользовано ${reported.length}`);
}

main().catch((e) => {
  log('ERROR', 'Fatal', { error: String(e) });
  process.exit(1);
});
