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

const PROD_URL = process.env.TOURHAB_URL || 'https://vedarai.ru';
const CRON_SECRET = process.env.CRON_SECRET || '';
const REPO = process.env.EVO_REPO || 'tourhabk-ui/pos';
const LABEL = 'evo';
// Эволюция 3.0, п.3: метка авто-запуска руки — её подхватывает claude.yml и
// ведёт находку до draft-PR. Вешается только на auto_runnable-находки (whitelist
// в issue-reporter) и только при EVO_AUTOPR=1: ключ руки без кредитов = красные
// прогоны, включает владелец переменной Actions.
const AUTO_LABEL = 'agent-proposal';
const AUTOPR_ENABLED = process.env.EVO_AUTOPR === '1';

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
  return {
    issues: Array.isArray(data.issues) ? data.issues : [],
    // Почему находок может быть ноль. Эндпоинт эти поля отдаёт давно, но раннер
    // печатал только счётчик — и «0» одинаково выглядел и когда сканеру нечего
    // сказать, и когда тормоз точности гасит код-находки (тогда наружу идут
    // только детерминированные категории, и петля молчит месяцами незаметно).
    precision: data.precision ?? null,
    guessesAllowed: data.guesses_allowed,
    precisionNote: data.precision_note ?? '',
    intelPrecision: data.intel_precision ?? null,
    intelGuessesAllowed: data.intel_guesses_allowed,
    intelPrecisionNote: data.intel_precision_note ?? '',
    rejectedByGuard: data.rejected_by_guard ?? 0,
    guessesHeld: data.guesses_held ?? 0,
    probeSlots: data.probe_slots ?? 0,
    publishGateBlockedStreak: data.publish_gate_blocked_streak ?? 0,
    // КТО именно даёт шум. Разрез по моделям эндпоинт считает с 771-й миграции
    // (она и заведена ради проверки гипотезы «врут слабые фоллбэк-модели»), а
    // раннер его не печатал — и тормоз десять прогонов подряд краснел числом
    // «22%», не называя виновника. Считать и не показать — то же, что не
    // считать: гипотеза остаётся спором.
    precisionByModel: Array.isArray(data.precision_by_model) ? data.precision_by_model : [],
  };
}

// Тот же порог, что у IDLE_RUNS_THRESHOLD (lib/agents/cron-idle.ts): один
// просевший прогон — шум, три подряд — обрыв, который надо увидеть, а не
// вычитывать из лога джобы вручную (см. миграция 912, 24.08 — тормоз стоял
// незамеченным несколько прогонов подряд именно так).
const PUBLISH_GATE_STREAK_THRESHOLD = 3;

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

function ensureAutoLabel() {
  try {
    gh(['label', 'create', AUTO_LABEL, '--repo', REPO, '--color', '1D76DB',
      '--description', 'Авто-запуск руки (claude.yml ведёт до draft-PR)', '--force']);
  } catch (e) {
    log('WARN', 'не удалось создать/обновить метку авто-запуска (не критично)', { error: String(e) });
  }
}

function createIssue(title, body, autoRunnable) {
  // Тело передаём аргументом, а НЕ через временный файл: execFileSync не
  // использует shell, поэтому произвольный/многострочный текст безопасен, а
  // сетевые данные не пишутся на диск (CodeQL: network→file / insecure temp).
  const args = ['issue', 'create', '--repo', REPO, '--title', title, '--body', body, '--label', LABEL];
  // Метка авто-запуска — при создании issue: claude.yml слушает событие
  // labeled и стартует сам. Только whitelisted-классы и только при флаге.
  if (autoRunnable && AUTOPR_ENABLED) args.push('--label', AUTO_LABEL);
  return gh(args);
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

  let report;
  try {
    report = await fetchReportable();
  } catch (e) {
    // Эндпоинт мог быть ещё не задеплоен (окно Timeweb) — не краснить job.
    log('WARN', 'не удалось получить находки — пустой прогон', { error: String(e) });
    return;
  }

  const findings = report.issues;
  log('EVO_REPORT', `находок к выносу: ${findings.length}`, {
    precision: report.precision,
    guesses_allowed: report.guessesAllowed,
    precision_note: report.precisionNote,
    intel_precision: report.intelPrecision,
    intel_guesses_allowed: report.intelGuessesAllowed,
    intel_precision_note: report.intelPrecisionNote,
    rejected_by_guard: report.rejectedByGuard,
    guesses_held: report.guessesHeld,
    probe_slots: report.probeSlots,
    publish_gate_blocked_streak: report.publishGateBlockedStreak,
  });
  if (report.guessesAllowed === false) {
    // Догадки модели придержаны тормозом точности. Само по себе это защита, но
    // молча она превращается в «эволюция ничего не находит».
    log('EVO_REPORT', 'догадки модели придержаны — тормоз точности', {
      precision: report.precision,
      precision_note: report.precisionNote,
      held: report.guessesHeld,
      probe: report.probeSlots,
      streak: report.publishGateBlockedStreak,
    });
    // Разрез по моделям печатается ТОЛЬКО когда тормоз сработал: в норме это
    // шум в логе, а при торможении — единственная подсказка, где чинить.
    // Пусто — честное «атрибуции пока нет» (записи до 771-й миграции), а не
    // «все модели одинаково хороши».
    log('EVO_REPORT', report.precisionByModel.length > 0
      ? 'точность по моделям'
      : 'точность по моделям: атрибуции нет ни у одной вынесенной находки', {
      by_model: report.precisionByModel,
    });
  }
  // Стрик тормоза виден в логе, но job из-за него не краснеет.
  // 39 красных прогонов из 40 с 18.10 были этим стриком уже после того,
  // как рука успешно завела issue. Сломанный вынос тогда не отличить.
  // Вынос того, что тормоз пускает (детерминированное и пробник), идёт дальше.
  if (report.publishGateBlockedStreak >= PUBLISH_GATE_STREAK_THRESHOLD && report.guessesAllowed === false) {
    log('WARN', `тормоз точности кода держит запрет ${report.publishGateBlockedStreak} прогонов подряд. Вынос не останавливается: детерминированные и пробник идут. Порог 50% не снижен.`, {
      precision: report.precision,
      precision_note: report.precisionNote,
    });
  }
  if (report.intelGuessesAllowed === false) {
    log('WARN', 'тормоз точности разведки держит запрет. Код-находки он не глушит.', {
      intel_precision: report.intelPrecision,
      intel_precision_note: report.intelPrecisionNote,
    });
  }
  if (findings.length === 0) return;

  ensureLabel();
  if (AUTOPR_ENABLED && findings.some((f) => f.auto_runnable)) ensureAutoLabel();

  const reported = [];
  for (const f of findings) {
    try {
      const existing = findExistingIssue(f.title);
      const url = existing || createIssue(f.title, f.body, f.auto_runnable === true);
      reported.push({ id: f.id, issue_url: url });
      log(existing ? 'DEDUP' : 'CREATE', f.title, { url, auto: f.auto_runnable === true && AUTOPR_ENABLED });
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
