#!/usr/bin/env node
/**
 * Напоминание загрузить скилл перед работой в его области (слово владельца
 * 27.11 «исправляй это экономит токены»).
 *
 * Повод. CLAUDE.md требует: «Перед правкой в области скилла — загрузи его».
 * Claude Code держит в контексте только описания скиллов, а полный текст
 * загружает, когда модель сама решит, что задача подходит. Решала она редко:
 * за сессию 22–27.11 (26 PR) скилл загружался 3 раза. Правки вёрстки, SQL,
 * миграций, агентов и SEO шли без своих скиллов, а PR — без pr-drive. Правило
 * казалось известным из ядра CLAUDE.md, и ничто этого не проверяло.
 *
 * Что делает хук:
 *  - перед Edit/Write находит скиллы области правленого файла;
 *  - перед `git … commit` делает то же по всем изменённым файлам рабочей
 *    копии: правки командами в терминале Edit не видит, а коммит видит все;
 *  - перед созданием PR называет pr-drive;
 *  - после вызова Skill записывает, что скилл в этой сессии загружен.
 *
 * Как бережёт токены: молчит, если скилл уже загружен; о каждом скилле
 * напоминает один раз за сессию; напоминание — одна строка контекста, правку
 * оно не останавливает. Скилл без области (аудит, разбор дня) хук не трогает:
 * их зовут по просьбе владельца.
 *
 * Отказ не глушится (§4.0): не смог прочитать вход или записать состояние —
 * строка в stderr и выход 0. Работа сессии из-за хука не встаёт.
 *
 * Сторож: tests/unit/skill-reminder.test.ts — исполняет хук на входах
 * Claude Code и держит связку: скиллы и каталоги таблицы существуют, хук
 * подключён в .claude/settings.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { zonesOfFile } from '../../scripts/protected-zones.mjs';

/**
 * Области скиллов: префикс пути от корня репозитория. `zones` — зоны §7 из
 * реестра scripts/protected-zones.mjs (свой список здесь отстал бы от него),
 * `extra` — правило, которое префиксом не выразить.
 *
 * @typedef {{ skill: string; why: string; prefixes?: string[]; zones?: boolean; extra?: (p: string) => boolean }} SkillArea
 * @type {readonly SkillArea[]}
 */
export const SKILL_AREAS = Object.freeze([
  { skill: 'vedar-protected-zones', why: 'зона §7 «НЕ ТРОГАТЬ»', zones: true },
  { skill: 'money-path', why: 'денежный путь', prefixes: ['lib/payments/', 'app/api/payments/', 'app/api/hub/operator/payments/'] },
  { skill: 'pg-verify', why: 'миграция', prefixes: ['migrations/'] },
  {
    skill: 'vedar-deploy',
    why: 'выкат и миграции',
    prefixes: ['migrations/', '.github/workflows/deploy.yml', '.github/workflows/ci.yml', 'Dockerfile', 'start.js', 'next.config.js'],
  },
  {
    skill: 'vedar-design-tokens',
    why: 'вёрстка',
    prefixes: ['components/'],
    // Страницы и стили app/. Роуты app/api/ — .ts, сюда не попадают.
    extra: (p) => p.startsWith('app/') && /\.(tsx|css)$/.test(p),
  },
  { skill: 'vedar-place-card', why: 'карточка места', prefixes: ['app/places/', 'lib/places/'] },
  { skill: 'vedar-route-card', why: 'карточка маршрута', prefixes: ['app/routes/', 'lib/routes/'] },
  { skill: 'vedar-tour-card', why: 'карточка тура', prefixes: ['lib/tours/', 'components/tours/'] },
  {
    skill: 'vedar-honesty',
    why: 'общая витрина',
    prefixes: ['app/operators/', 'lib/operators/', 'lib/partners/', 'lib/legal/', 'lib/tours/offer-order.ts'],
  },
  { skill: 'vedar-transfer-card', why: 'трансферы', prefixes: ['app/transfers/', 'lib/transfers/', 'components/transfers/'] },
  { skill: 'vedar-map-standard', why: 'карта', prefixes: ['lib/map/', 'components/map/'] },
  { skill: 'vedar-trip-plan', why: 'план поездки', prefixes: ['lib/planner/', 'app/planning/', 'components/planner/'] },
  { skill: 'vedar-requests', why: 'заявки', prefixes: ['lib/requests/', 'lib/stay/', 'lib/leads/'] },
  { skill: 'vedar-after-refusal', why: 'очередь менеджера', prefixes: ['lib/manager-queue/'] },
  { skill: 'vedar-ai-agents', why: 'агенты и модели', prefixes: ['lib/agents/', 'lib/ai/', 'lib/kuzmich/'] },
  { skill: 'vedar-sister-repos', why: 'соседние репозитории', prefixes: ['lib/mcp/sister-repos.ts'] },
  { skill: 'pd-guard', why: 'сообщения людям', prefixes: ['lib/notifications/', 'lib/telegram/', 'lib/max/'] },
  { skill: 'seo', why: 'SEO', prefixes: ['lib/seo/', 'scripts/seo/', 'app/robots.ts', 'app/sitemap.xml'] },
  { skill: 'vedar-code-rules', why: 'сторож', prefixes: ['tests/'] },
]);

/** Скилл процесса, а не файла: перед созданием PR. */
export const PR_SKILL = 'pr-drive';
const PR_TOOLS = new Set(['mcp__github__create_pull_request']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** `git commit`, в том числе `git -c core.hooksPath=/dev/null commit` и после `cd … &&`. */
const GIT_COMMIT = /(?:^|[\s;&|(])git(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/;

/** Скиллы области файла: путь от корня репозитория, `/` как разделитель. */
export function skillsForFile(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('..')) return [];
  return SKILL_AREAS.filter(
    (a) =>
      (a.zones && zonesOfFile(rel).length > 0) ||
      (a.prefixes ?? []).some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p)) ||
      (a.extra ? a.extra(rel) : false),
  ).map((a) => ({ skill: a.skill, why: a.why }));
}

function relPath(file, root) {
  if (typeof file !== 'string' || file === '') return '';
  const r = isAbsolute(file) ? relative(root, file) : file;
  return r.split('\\').join('/');
}

/** Изменённые файлы рабочей копии: всё, что может уйти в коммит. */
function changedFiles(cwd) {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '-z'], { cwd, encoding: 'utf8' });
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    files.push(e.slice(3));
    // Переименование: за записью идёт старое имя — его пропускаем.
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return files;
}

function stateFile(sessionId) {
  const dir = process.env.SKILL_REMINDER_DIR || join(tmpdir(), 'claude-skill-reminder');
  const safe = String(sessionId || 'unknown-session').replace(/[^A-Za-z0-9_-]/g, '_');
  return { dir, file: join(dir, `${safe}.json`) };
}

function readState(sessionId) {
  const { file } = stateFile(sessionId);
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return { loaded: Array.isArray(s.loaded) ? s.loaded : [], reminded: Array.isArray(s.reminded) ? s.reminded : [] };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { loaded: [], reminded: [] };
    process.stderr.write(`skill-reminder: состояние сессии не прочитано (${e && e.message}), считаю пустым\n`);
    return { loaded: [], reminded: [] };
  }
}

function writeState(sessionId, state) {
  const { dir, file } = stateFile(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

/**
 * Решение по одному событию Claude Code. Возвращает текст для контекста или
 * null, когда сказать нечего.
 */
export function decide(input, root) {
  const event = input?.hook_event_name;
  const tool = input?.tool_name;
  const sessionId = input?.session_id;

  if (event === 'PostToolUse' && tool === 'Skill') {
    const name = input?.tool_input?.skill;
    if (typeof name !== 'string' || name === '') return null;
    const st = readState(sessionId);
    if (!st.loaded.includes(name)) st.loaded.push(name);
    writeState(sessionId, st);
    return null;
  }
  if (event !== 'PreToolUse') return null;

  /** @type {{ skill: string; why: string; file?: string }[]} */
  let wanted = [];
  let where = '';
  if (EDIT_TOOLS.has(tool)) {
    const rel = relPath(input?.tool_input?.file_path ?? input?.tool_input?.notebook_path, root);
    wanted = skillsForFile(rel).map((s) => ({ ...s, file: rel }));
    where = 'Правка';
  } else if (tool === 'Bash' && GIT_COMMIT.test(String(input?.tool_input?.command ?? ''))) {
    const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : root;
    for (const f of changedFiles(cwd)) {
      for (const s of skillsForFile(f)) if (!wanted.some((w) => w.skill === s.skill)) wanted.push({ ...s, file: f });
    }
    where = 'Коммит';
  } else if (PR_TOOLS.has(tool)) {
    wanted = [{ skill: PR_SKILL, why: 'создание PR' }];
    where = 'PR';
  } else {
    return null;
  }

  const st = readState(sessionId);
  const fresh = [];
  for (const w of wanted) {
    if (st.loaded.includes(w.skill) || st.reminded.includes(w.skill) || fresh.some((f) => f.skill === w.skill)) continue;
    fresh.push(w);
  }
  if (fresh.length === 0) return null;
  st.reminded.push(...fresh.map((f) => f.skill));
  writeState(sessionId, st);

  const list = fresh.map((f) => `${f.skill} (${f.why}${f.file ? `: ${f.file}` : ''})`).join('; ');
  return (
    `${where} задевает область скиллов, не загруженных в этой сессии: ${list}. ` +
    'CLAUDE.md: «Перед правкой в области скилла — загрузи его». Загрузи инструментом Skill и сверь работу с ним. ' +
    'Об этих скиллах хук больше не напомнит.'
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (e) {
    process.stderr.write(`skill-reminder: вход хука не разобран (${e && e.message}), напоминания не будет\n`);
    process.exit(0);
  }
  const root = process.env.CLAUDE_PROJECT_DIR || (typeof input?.cwd === 'string' && input.cwd) || process.cwd();
  try {
    const text = decide(input, root);
    if (text) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } }) + '\n',
      );
    }
  } catch (e) {
    process.stderr.write(`skill-reminder: ${input?.tool_name ?? '?'}: ${e && e.message}\n`);
  }
  process.exit(0);
}
