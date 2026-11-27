#!/usr/bin/env node
/**
 * Проверки перед коммитом (слово владельца 27.11 «почини проверки перед
 * коммитом»).
 *
 * Было: три хука PreToolUse в .claude/settings.json — tsc, аудит правил
 * CLAUDE.md, напоминание про колонки SQL. Срабатывали они только на команду,
 * которая начинается с `git commit` (`"if": "Bash(git commit*)"` и
 * `case *"git commit"*`). Коммит вида `git -c core.hooksPath=/dev/null commit`
 * или `cd … && git add … && git commit` они пропускали молча, а именно так
 * коммитят сессии. Вдобавок:
 *  - аудит и напоминание смотрели только застейдженное, а при
 *    `git add … && git commit` одной командой к началу хука не застейджено
 *    ничего;
 *  - отказ печатался JSON-ом с кодом выхода 2, а при коде 2 Claude Code
 *    берёт причину из stderr, и модель видела отказ без причины;
 *  - напоминание про SQL уходило в `systemMessage` (его видит человек, а не
 *    модель) и ловило любое `import … from`, потому что искало «FROM» без
 *    учёта регистра.
 *
 * Стало — один скрипт:
 *  - коммит узнаётся тем же выражением, что у напоминания о скиллах
 *    (GIT_COMMIT из skill-reminder.mjs);
 *  - файлы — все изменённые в рабочей копии, как там же;
 *  - TypeScript (`tsc --noEmit` из node_modules проекта) — только когда
 *    изменён код или его настройка: коммит одних документов не ждёт 15 секунд;
 *  - аудит правил (`.claude/skills/kamchatka/scripts/audit.mjs --files`) —
 *    по изменённым .ts/.tsx в app/, lib/, components/;
 *  - ошибки TypeScript или критичное нарушение аудита останавливают коммит:
 *    код выхода 2, причина — в stderr, её видит модель;
 *  - новые SQL-запросы в изменённых файлах — одна строка в контекст модели,
 *    коммит идёт.
 *
 * Проверка, которая не смогла выполниться (нет npx, вышло время, аудит упал),
 * коммит не останавливает и не выдаётся за «чисто» (§4.0): модель получает
 * строку «не смог проверить» с причиной.
 *
 * Сторож: tests/unit/commit-gate.test.ts.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GIT_COMMIT, changedFiles } from './skill-reminder.mjs';

/** Изменение, после которого нужен tsc: код или его настройка. */
export const TSC_TRIGGER = /\.(ts|tsx|mts|cts|js|mjs|cjs)$|(^|\/)(tsconfig[^/]*\.json|package(-lock)?\.json)$/;
/** Что смотрит аудит: те же каталоги, что при его полном прогоне. */
export const AUDIT_FILE = /^(app|lib|components)\/.+\.(ts|tsx)$/;
/** Где искать новые SQL-запросы. */
export const SQL_FILE = /\.(ts|tsx|sql)$/;
/** Добавленная строка с SQL. Ключевые слова заглавными: `import … from` не SQL. */
export const SQL_LINE = /^\+(?!\+\+).*(\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|JOIN)\b|\bpool\.query\(|\.query\()/m;

const LIMIT = 5;

export function isCommit(command) {
  return GIT_COMMIT.test(String(command ?? ''));
}

/**
 * Решение по коммиту. `run` — исполнители проверок: настоящие в хуке,
 * подставные в тесте. Возвращает { block, context, ran }: block — причина
 * остановки (null — коммит идёт), context — строка для модели.
 */
export function gate({ files, run }) {
  const ran = [];
  const blocks = [];
  const notes = [];

  if (files.some((f) => TSC_TRIGGER.test(f))) {
    ran.push('tsc');
    const r = run.tsc();
    const errors = r.output.split('\n').filter((l) => /error TS\d+/.test(l));
    if (errors.length > 0) {
      blocks.push(`TypeScript: ${errors.length} ошиб. Первые:\n${errors.slice(0, LIMIT).join('\n')}\nИсправь и повтори коммит (npx tsc --noEmit).`);
    } else if (r.status !== 0) {
      notes.push(`TypeScript не проверен: ${r.reason || `код выхода ${r.status}`}. Это не «чисто»: запусти npx tsc --noEmit сам.`);
    }
  }

  const auditFiles = files.filter((f) => AUDIT_FILE.test(f));
  if (auditFiles.length > 0) {
    ran.push('audit');
    const r = run.audit(auditFiles);
    // Код 1 у node — и «нашёл критичное», и упавший скрипт. Остановка — только
    // когда в выводе есть сами нарушения.
    const critical = r.status === 1 ? criticalLines(r.output) : [];
    if (critical.length > 0) {
      blocks.push(
        `Аудит правил CLAUDE.md: критичные нарушения в изменённых файлах:\n${critical.slice(0, LIMIT * 2).join('\n')}\n` +
          'Исправь. Ложное срабатывание — пометка audit-ignore в строке.',
      );
    } else if (r.status !== 0) {
      notes.push(`Аудит правил не выполнен: ${r.reason || `код выхода ${r.status}`}. Это не «чисто»: запусти node .claude/skills/kamchatka/scripts/audit.mjs --files <файлы>.`);
    }
  }

  const sqlFiles = files.filter((f) => SQL_FILE.test(f));
  if (sqlFiles.length > 0) {
    ran.push('sql');
    const added = run.addedLines(sqlFiles);
    if (added === null) {
      notes.push('Новые SQL-запросы не проверены: изменения не прочитались.');
    } else if (SQL_LINE.test(added)) {
      notes.push(
        'В коммите новые SQL-запросы: сверь колонки по migrations/ и docs/DB_SCHEMA.md, а запрос — на настоящем PostgreSQL (скилл pg-verify). Угаданное имя колонки — битый прод.',
      );
    }
  }

  return {
    block: blocks.length ? `Коммит остановлен проверкой перед коммитом (.claude/hooks/commit-gate.mjs).\n\n${blocks.join('\n\n')}` : null,
    context: notes.length ? notes.join(' ') : null,
    ran,
  };
}

/** Строки раздела «КРИТИЧНЫЕ» из вывода аудита. */
function criticalLines(output) {
  const out = [];
  let inside = false;
  for (const line of output.split('\n')) {
    if (/^КРИТИЧНЫЕ/.test(line)) { inside = true; continue; }
    if (/^(ПРЕДУПРЕЖДЕНИЯ|ИТОГО)/.test(line)) inside = false;
    if (inside && line.trim()) out.push(line.trimEnd());
  }
  return out;
}

function exec(cmd, args, cwd, timeout) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const reason = r.error ? r.error.message : r.signal ? `остановлен сигналом ${r.signal}` : '';
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, reason };
}

/**
 * Настоящие исполнители проверок в корне репозитория. tsc — из
 * node_modules проекта, а не через npx: npx без установленного typescript
 * скачал бы из npm чужой пакет с именем tsc.
 */
export function realRunners(root) {
  const tscBin = join(root, 'node_modules/typescript/bin/tsc');
  const auditBin = join(root, '.claude/skills/kamchatka/scripts/audit.mjs');
  return {
    tsc: () =>
      existsSync(tscBin)
        ? exec(process.execPath, [tscBin, '--noEmit'], root, 110_000)
        : { status: -1, output: '', reason: 'нет node_modules/typescript (npm ci не запускался)' },
    audit: (files) =>
      existsSync(auditBin)
        ? exec(process.execPath, [auditBin, '--files', ...files], root, 60_000)
        : { status: -1, output: '', reason: 'нет скрипта аудита .claude/skills/kamchatka/scripts/audit.mjs' },
    addedLines: (files) => {
      const d = exec('git', ['-c', 'color.ui=false', 'diff', '--no-ext-diff', 'HEAD', '--', ...files], root, 20_000);
      if (d.status !== 0) return null;
      const untracked = exec('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files], root, 20_000);
      if (untracked.status !== 0) return null;
      let text = d.output;
      for (const f of untracked.output.split('\0').map((s) => s.trim()).filter(Boolean)) {
        const p = join(root, f);
        if (existsSync(p)) text += '\n' + readFileSync(p, 'utf8').split('\n').map((l) => `+${l}`).join('\n');
      }
      return text;
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (e) {
    process.stderr.write(`commit-gate: вход хука не разобран (${e && e.message}), проверки перед коммитом не выполнены\n`);
    process.exit(0);
  }
  if (input?.tool_name !== 'Bash' || !isCommit(input?.tool_input?.command)) process.exit(0);
  const root = process.env.CLAUDE_PROJECT_DIR || (typeof input?.cwd === 'string' && input.cwd) || process.cwd();
  let result;
  try {
    result = gate({ files: changedFiles(root), run: realRunners(root) });
  } catch (e) {
    const text = `Проверки перед коммитом не выполнены: ${e && e.message}. Это не «чисто»: запусти npx tsc --noEmit и аудит сам.`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }) + '\n');
    process.exit(0);
  }
  if (result.block) {
    process.stderr.write(result.block + (result.context ? `\n\n${result.context}` : '') + '\n');
    process.exit(2);
  }
  if (result.context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: result.context } }) + '\n');
  }
  process.exit(0);
}
