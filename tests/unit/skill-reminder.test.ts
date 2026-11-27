/**
 * Напоминание загрузить скилл перед работой в его области и шапки скиллов
 * (слово владельца 27.11 «исправляй это экономит токены»).
 *
 * Повод: за сессию 22–27.11 скилл загружался 3 раза на 26 PR, хотя CLAUDE.md
 * требует загружать его перед правкой в его области. Хук
 * `.claude/hooks/skill-reminder.mjs` судится исполнением: процесс получает
 * событие Claude Code на stdin, как от самого Claude Code, и либо молчит,
 * либо отдаёт одну строку контекста.
 *
 * Шапки: Claude Code показывает модели только имя и описание скилла. Скилл
 * без описания модель не вызовет никогда — так было у
 * make-interfaces-feel-better.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
// @ts-expect-error — хук на чистом JS без деклараций типов
import { SKILL_AREAS, PR_SKILL } from '../../.claude/hooks/skill-reminder.mjs';
// @ts-expect-error — реестр зон на чистом JS без деклараций типов
import { PROTECTED_ZONES } from '../../scripts/protected-zones.mjs';

const ROOT = process.cwd();
const HOOK = join(ROOT, '.claude/hooks/skill-reminder.mjs');
const SKILLS_DIR = join(ROOT, '.claude/skills');
const tmpRoots: string[] = [];
let stateDir = '';
let session = '';
let seq = 0;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/** Событие Claude Code → то, что хук отдал в контекст (null — промолчал). */
function hook(input: Record<string, unknown>, raw?: string): { context: string | null; stderr: string; status: number | null } {
  const r = spawnSync('node', [HOOK], {
    input: raw ?? JSON.stringify({ session_id: session, cwd: ROOT, ...input }),
    env: { ...process.env, SKILL_REMINDER_DIR: stateDir, CLAUDE_PROJECT_DIR: ROOT },
    encoding: 'utf8',
  });
  const out = r.stdout.trim();
  if (!out) return { context: null, stderr: r.stderr, status: r.status };
  const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(parsed.hookSpecificOutput.hookEventName).toBe(input.hook_event_name);
  return { context: parsed.hookSpecificOutput.additionalContext, stderr: r.stderr, status: r.status };
}

const edit = (file: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
const loaded = (skill: string) => hook({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill } });

beforeEach(() => {
  stateDir = stateDir || tmp('skill-reminder-');
  session = `s${++seq}`;
});

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe('напоминание перед правкой', () => {
  it('правка вёрстки называет vedar-design-tokens один раз за сессию', () => {
    const first = edit(join(ROOT, 'components/rental/RentalCompanyCard.tsx')).context;
    expect(first).toMatch(/vedar-design-tokens \(вёрстка: components\/rental\/RentalCompanyCard\.tsx\)/);
    expect(first).toMatch(/Перед правкой в области скилла — загрузи его/);
    // Второй файл той же области — молчание: напоминание одно на сессию.
    expect(edit(join(ROOT, 'components/shared/AccommodationCard.tsx')).context).toBeNull();
  });

  it('загруженный скилл не напоминается, другой скилл той же правки — да', () => {
    loaded('vedar-design-tokens');
    const ctx = edit(join(ROOT, 'components/transfers/CharterCard.tsx')).context;
    expect(ctx).toMatch(/vedar-transfer-card/);
    expect(ctx).not.toMatch(/vedar-design-tokens/);
  });

  it('страница и стили app/ — вёрстка, роут app/api/ — нет', () => {
    expect(edit(join(ROOT, 'app/accommodations/_AccommodationsClient.tsx')).context).toMatch(/vedar-design-tokens/);
    session = `s${++seq}`;
    expect(edit(join(ROOT, 'app/globals.css')).context).toMatch(/vedar-design-tokens/);
    expect(edit(join(ROOT, 'app/api/health/route.ts')).context).toBeNull();
  });

  it('зона §7 из реестра называет vedar-protected-zones, оплата — ещё и money-path', () => {
    const zoneFile = (PROTECTED_ZONES as { paths: string[] }[]).flatMap((z) => z.paths).find((p) => !p.endsWith('/**'));
    expect(zoneFile).toBeTruthy();
    expect(edit(join(ROOT, zoneFile!)).context).toMatch(/vedar-protected-zones \(зона §7/);
    session = `s${++seq}`;
    const pay = edit(join(ROOT, 'lib/payments/accepting.ts')).context;
    expect(pay).toMatch(/vedar-protected-zones/);
    expect(pay).toMatch(/money-path/);
  });

  it('файл вне областей и вне репозитория — молчание', () => {
    expect(edit(join(ROOT, 'README.md')).context).toBeNull();
    expect(edit('/etc/hosts').context).toBeNull();
  });

  it('относительный путь судится так же', () => {
    expect(edit('migrations/9999_x.sql').context).toMatch(/pg-verify/);
  });
});

describe('напоминание перед коммитом и PR', () => {
  it('коммит видит правки, сделанные мимо Edit, в том числе с -c и после cd', () => {
    const repo = tmp('skill-reminder-git-');
    execFileSync('git', ['-c', 'color.ui=false', 'init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'migrations'));
    writeFileSync(join(repo, 'migrations/9999_x.sql'), 'SELECT 1;\n');
    const bash = (command: string) =>
      hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo, tool_input: { command } }).context;
    expect(bash('git status --short')).toBeNull();
    const ctx = bash(`cd ${repo} && git -c core.hooksPath=/dev/null commit -F msg.txt`);
    expect(ctx).toMatch(/^Коммит задевает/);
    expect(ctx).toMatch(/pg-verify \(миграция: migrations\/9999_x\.sql\)/);
    expect(ctx).toMatch(/vedar-deploy/);
  });

  it('создание PR называет pr-drive, пока он не загружен', () => {
    const pr = () => hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__create_pull_request', tool_input: {} }).context;
    loaded(PR_SKILL);
    expect(pr()).toBeNull();
    session = `s${++seq}`;
    expect(pr()).toMatch(/pr-drive \(создание PR\)/);
  });
});

describe('хук не мешает работе и не молчит об отказе', () => {
  it('неразобранный вход — выход 0, ни строки в контекст, причина в stderr', () => {
    const r = hook({ hook_event_name: 'PreToolUse' }, '{не json');
    expect(r.status).toBe(0);
    expect(r.context).toBeNull();
    expect(r.stderr).toMatch(/вход хука не разобран/);
  });

  it('чужое событие — молчание', () => {
    expect(hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(ROOT, 'components/x.tsx') } }).context).toBeNull();
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(ROOT, 'components/x.tsx') } }).context).toBeNull();
  });
});

describe('связка: таблица, скиллы и подключение', () => {
  const areas = SKILL_AREAS as { skill: string; prefixes?: string[] }[];

  it('каждый скилл таблицы существует', () => {
    for (const s of [...areas.map((a) => a.skill), PR_SKILL]) {
      expect(existsSync(join(SKILLS_DIR, s, 'SKILL.md')), `нет скилла ${s}`).toBe(true);
    }
  });

  it('каждый путь таблицы существует: переехавший каталог краснеет здесь', () => {
    for (const a of areas) for (const p of a.prefixes ?? []) expect(existsSync(join(ROOT, p)), `${a.skill}: нет ${p}`).toBe(true);
  });

  it('хук подключён в .claude/settings.json на все свои события', () => {
    const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    const wired = (event: string, tool: string) =>
      (settings.hooks[event] ?? []).some(
        (e) => new RegExp(`^(?:${e.matcher ?? ''})$`).test(tool) && e.hooks.some((h) => h.command.includes('.claude/hooks/skill-reminder.mjs')),
      );
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'mcp__github__create_pull_request']) {
      expect(wired('PreToolUse', tool), `PreToolUse ${tool}`).toBe(true);
    }
    expect(wired('PostToolUse', 'Skill'), 'PostToolUse Skill').toBe(true);
  });
});

/** Поля шапки SKILL.md: name, description, when_to_use (строкой, со сложенными блоками). */
function frontmatter(text: string): Record<string, string> | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1]) && !/^[A-Za-z_][\w-]*:/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      value = block.join(' ').trim();
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    out[kv[1]] = value;
  }
  return out;
}

describe('шапки скиллов: модель видит имя и описание', () => {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  it('скиллы на месте', () => {
    expect(dirs.length).toBeGreaterThan(10);
  });

  for (const dir of dirs) {
    it(dir, () => {
      const file = join(SKILLS_DIR, dir, 'SKILL.md');
      expect(existsSync(file), 'нет SKILL.md').toBe(true);
      const fm = frontmatter(readFileSync(file, 'utf8'));
      expect(fm, 'нет шапки между ---').not.toBeNull();
      expect(fm!.name, 'name не совпадает с папкой').toBe(dir);
      expect((fm!.description ?? '').length, 'пустое описание: модель скилл не вызовет').toBeGreaterThan(40);
      // Claude Code режет описание вместе с when_to_use на 1536 символах.
      expect((fm!.description ?? '').length + (fm!.when_to_use ?? '').length).toBeLessThanOrEqual(1536);
    });
  }
});
