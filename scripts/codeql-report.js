/**
 * scripts/codeql-report.js — вынести находки CodeQL из SARIF на свет.
 *
 * 23.08.2026: три алерта CodeQL (один высокий) висели непрочитанными.
 * Читать их было НЕЧЕМ: SARIF уезжает в Security-таб, а туда нужен доступ
 * `security_events`, которого нет ни у токена сессии, ни у агента в репозитории
 * (`403 Resource not accessible by integration`). Скачать артефакт тоже нельзя —
 * ссылка ведёт на blob-хранилище, закрытое сетевой политикой.
 *
 * Получалась проверка, чей результат виден ровно одному человеку и ровно в
 * браузере. Для всех остальных она отвечала «не знаю» — но выглядела зелёной
 * галочкой (§4.0: место, где нельзя сказать «не знаю», заполняется враньём).
 *
 * Здесь SARIF разбирается на месте и печатается ДВАЖДЫ: в `$GITHUB_STEP_SUMMARY`
 * (владельцу, таблицей во вкладке прогона) и в stdout (в лог джоба — его
 * читает API, в отличие от Summary и артефактов).
 *
 * Три исхода, как и требует §4.0:
 *   находки есть   → перечислены поимённо, с файлом и строкой;
 *   находок нет    → сказано вслух, а не молчанием;
 *   прочитать не смог → выход 1 с причиной. Пустой отчёт не выдаётся за чистый.
 *
 * Сам по себе скрипт сборку не роняет из-за находок: гасить main, где работают
 * несколько веток сразу, — решение владельца, а не побочный эффект починки
 * читаемости.
 */

const fs = require('fs');
const path = require('path');

/**
 * Уровень находки. `security-severity` — число от CodeQL; когда его нет,
 * берётся `level`; когда нет и его — так и говорится, а не подставляется
 * «низкая» (иначе непонятая находка тихо становится неважной).
 */
function severityOf(result, rulesById) {
  const rule = rulesById.get(result.ruleId) ?? {};
  const raw = rule.properties?.['security-severity'];
  const num = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(num)) {
    if (num >= 9.0) return { label: 'критическая', rank: 4, score: num };
    if (num >= 7.0) return { label: 'высокая', rank: 3, score: num };
    if (num >= 4.0) return { label: 'средняя', rank: 2, score: num };
    if (num > 0) return { label: 'низкая', rank: 1, score: num };
  }
  const level = result.level ?? rule.defaultConfiguration?.level;
  if (level === 'error') return { label: 'ошибка', rank: 3, score: null };
  if (level === 'warning') return { label: 'предупреждение', rank: 2, score: null };
  if (level === 'note') return { label: 'замечание', rank: 1, score: null };
  return { label: 'уровень не указан', rank: 0, score: null };
}

function placeOf(result) {
  const loc = result.locations?.[0]?.physicalLocation;
  const uri = loc?.artifactLocation?.uri;
  const line = loc?.region?.startLine;
  if (!uri) return null;
  return line === undefined ? uri : `${uri}:${line}`;
}

/** Разбор одного SARIF. Возвращает находки; бросает, если файл не разобрать. */
function findingsOf(sarif) {
  const out = [];
  for (const run of sarif.runs ?? []) {
    const rulesById = new Map();
    for (const r of run.tool?.driver?.rules ?? []) rulesById.set(r.id, r);
    for (const ext of run.tool?.extensions ?? []) {
      for (const r of ext.rules ?? []) rulesById.set(r.id, r);
    }
    for (const res of run.results ?? []) {
      const sev = severityOf(res, rulesById);
      out.push({
        ruleId: res.ruleId ?? 'правило не названо',
        title: rulesById.get(res.ruleId)?.shortDescription?.text ?? null,
        message: res.message?.text ?? '',
        place: placeOf(res),
        severity: sev.label,
        rank: sev.rank,
        score: sev.score,
      });
    }
  }
  out.sort((a, b) => b.rank - a.rank);
  return out;
}

function render(findings) {
  const lines = [];
  lines.push('## CodeQL: находки');
  lines.push('');
  if (findings.length === 0) {
    lines.push('Находок нет. Это ответ анализа, а не отсутствие ответа: SARIF прочитан, результатов ноль.');
    return lines.join('\n');
  }
  lines.push(`Всего: ${findings.length}.`);
  lines.push('');
  lines.push('| Уровень | Правило | Где | Что |');
  lines.push('| --- | --- | --- | --- |');
  for (const f of findings) {
    const sev = f.score === null ? f.severity : `${f.severity} (${f.score})`;
    // Обратный слеш экранируется ПЕРВЫМ: иначе добавленный нами `\|`
    // сам становится материалом для следующей замены, и `a\|b` из находки
    // разъезжает таблицу. Находка js/incomplete-sanitization на этой самой
    // строке — первая, что напечатал новый разбор, и она была верной.
    const cell = (s) => String(s ?? 'не указано')
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
    lines.push(`| ${cell(sev)} | ${cell(f.ruleId)} | ${cell(f.place)} | ${cell(f.title ?? f.message)} |`);
  }
  lines.push('');
  lines.push('### Подробно');
  for (const f of findings) {
    lines.push('');
    lines.push(`- **${f.severity} — ${f.ruleId}**`);
    lines.push(`  - где: \`${f.place ?? 'место не указано'}\``);
    lines.push(`  - что: ${f.message || f.title || 'текст находки пуст'}`);
  }
  return lines.join('\n');
}

function sarifFilesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sarif'))
    .map((f) => path.join(dir, f));
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('[codeql-report] не задан каталог с SARIF');
    process.exit(1);
  }
  const files = sarifFilesIn(dir);
  if (files.length === 0) {
    // Именно здесь и жила бы ложь: шаг без SARIF, печатающий «находок нет»,
    // зелёный и бессмысленный. Пусть краснеет — читать было нечего.
    console.error(`[codeql-report] в ${dir} нет ни одного .sarif — анализ не прочитан`);
    process.exit(1);
  }

  const findings = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`[codeql-report] ${file} не разбирается: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    findings.push(...findingsOf(parsed));
  }
  findings.sort((a, b) => b.rank - a.rank);

  const text = render(findings);
  console.log(text);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${text}\n`);

  // Аннотации в интерфейсе прогона — кликабельные ссылки на файл и строку.
  for (const f of findings.filter((x) => x.rank >= 3)) {
    const loc = f.place ? f.place.split(':') : [];
    const file = loc[0] ?? '';
    const line = loc[1] ?? '';
    const where = file ? `file=${file}${line ? `,line=${line}` : ''}` : '';
    console.log(`::warning ${where}::${f.ruleId}: ${(f.message || f.title || '').replace(/\n/g, ' ')}`);
  }
}

if (require.main === module) main();

module.exports = { severityOf, placeOf, findingsOf, render, sarifFilesIn };
