/**
 * Сторож: логинов и паролей открытым текстом в коде нет.
 *
 * Репозиторий публичный. До 09.10 scripts/research/platforms.config.ts держал
 * шесть паролей и восемь почт от кабинетов площадок (Tripster, Sputnik8,
 * Туристер, Zoon, Level.Travel, Travelpayouts…) — с 17.05, коммит 425e4c19c.
 * Секреты — только в окружении (CLAUDE.md §4: «Секреты в коде — только
 * .env.local»).
 *
 * Ловит строковый литерал у ключа password и литеральные email/login/password
 * внутри объекта credentials. Подписи и сообщения форм (кириллица, пробелы)
 * паролями не считаются.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DIRS = ['app', 'lib', 'scripts', 'components', 'hooks'];
const EXT = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((name) => {
    if (name === 'node_modules' || name === '.next') return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : EXT.test(name) ? [full] : [];
  });
}

const PASSWORD_LITERAL = /\bpassword\s*[:=]\s*(['"`])([^'"`\n]+)\1/gi;
const CREDENTIALS_LITERAL = /credentials\s*:\s*\{[^{}]*\b(?:email|login|password)\s*:\s*(['"`])[^'"`\n]+\1/g;

/** Похоже на подпись или сообщение, а не на пароль. */
const looksLikeLabel = (v: string) => /[А-Яа-яЁё\s]/.test(v) || v.includes('${') || /^\*+$/.test(v);

function findings(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(PASSWORD_LITERAL)) {
    if (!looksLikeLabel(m[2] ?? '')) out.push(`password = «${'*'.repeat(Math.min((m[2] ?? '').length, 8))}»`);
  }
  for (const _ of src.matchAll(CREDENTIALS_LITERAL)) out.push('литерал в credentials');
  return out;
}

describe('секретов открытым текстом в коде нет', () => {
  const files = DIRS.flatMap((d) => walk(join(ROOT, d)));

  it('обходит исходники', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('ни пароля, ни логина площадки литералом', () => {
    const bad = files
      .map((f) => ({ f: relative(ROOT, f), hits: findings(readFileSync(f, 'utf8')) }))
      .filter((x) => x.hits.length > 0)
      .map((x) => `${x.f}: ${x.hits.join(', ')}`);
    expect(bad).toEqual([]);
  });

  it('конфиг аудита площадок берёт доступы из окружения', () => {
    const src = readFileSync(join(ROOT, 'scripts/research/platforms.config.ts'), 'utf8');
    const ids = [...src.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
    const fromEnv = [...src.matchAll(/credentials:\s*credentialsFromEnv\('([^']+)'\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(fromEnv).toEqual(ids);
    expect(src).toMatch(/process\.env\[`RESEARCH_\$\{key\}_PASSWORD`\]/);
  });

  it('сам детектор ловит пароль и пропускает подписи', () => {
    expect(findings("credentials: { email: 'a@b.ru', password: 'Qwerty123' }").length).toBeGreaterThan(0);
    expect(findings("const cfg = { password: 'hunter2' }")).toHaveLength(1);
    expect(findings("labels = { password: 'Пароль' }; msg = { password: 'Введите пароль' }")).toEqual([]);
    expect(findings('password: process.env.X')).toEqual([]);
  });
});
