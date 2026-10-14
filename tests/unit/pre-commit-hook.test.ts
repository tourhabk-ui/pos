// @vitest-environment node
/**
 * Хук .husky/pre-commit — запуском, а не чтением (#2451).
 *
 * Хук гоняется так же, как его зовёт husky (`sh -e`), во временном
 * git-репозитории с подготовленным индексом. Судят исход: код выхода и что
 * сказано человеку.
 *
 * Держит обе половины. Ранний сигнал о прямом вызове провайдера жив и
 * указывает на водопад. Стекло хук не останавливает: решение владельца 26.09
 * — поверх фото и карт стекло законно. Прежний запрет `backdrop-blur-`
 * останавливал коммит в любой файл со стеклом, а устаревшие токены
 * (premium-*) по-прежнему запрещены. Комментарий, называющий правило
 * словами, нарушением не считается.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HOOK = join(process.cwd(), '.husky/pre-commit');

interface ExecFailure { status: number | null; stdout: string }

function isExecFailure(err: unknown): err is ExecFailure {
  return typeof err === 'object' && err !== null && 'status' in err && 'stdout' in err;
}

/** Без GIT_*: запущенный из чужого хука тест иначе писал бы в чужой индекс. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return env;
}

function runHook(files: Record<string, string>): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pre-commit-'));
  const env = cleanEnv();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir, env });
    try {
      const out = execFileSync('sh', ['-e', HOOK], { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (err) {
      if (!isExecFailure(err)) throw err;
      return { code: err.status, out: String(err.stdout) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('хук pre-commit (#2451)', () => {
  it('прямой вызов провайдера в новом файле останавливает коммит и называет водопад', () => {
    const r = runHook({ 'lib/new-feature.ts': 'export async function f(m: string[]) {\n  return await callDeepSeek(m);\n}\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('прямой вызов провайдера');
    expect(r.out).toContain('callAIWaterfall()');
    expect(r.out).toContain('lib/new-feature.ts:2:');
    expect(r.out).not.toContain('ключ просрочен');
    // Под dash `echo -e` печатал «-e» перед каждой строкой.
    expect(r.out.split('\n').filter((line) => line.startsWith('-e '))).toEqual([]);
  });

  it('тест, держащий запрещённое как данные, коммит не останавливает', () => {
    const r = runHook({
      'tests/unit/guard.test.ts': "expect(at('await callDeepSeek(m)')).toEqual([1]);\n",
      'lib/safety/geofence.test.ts': "const legacy = 'text-premium-gold';\n",
    });
    expect(r.code).toBe(0);
  });

  it('секрет в коммите без кода останавливает коммит', () => {
    // Ключ собирается при запуске: в исходнике теста его нет целиком.
    const fake = `sk-or-v1-${'a1'.repeat(20)}`;
    const r = runHook({ 'config/keys.json': JSON.stringify({ openrouter: fake }) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('СЕКРЕТ В КОДЕ');
    expect(r.out).not.toContain(fake);
  });

  it('вызов через водопад проходит', () => {
    const r = runHook({ 'lib/new-feature.ts': 'export async function f(m: string[]) {\n  return await callAIWaterfall(m);\n}\n' });
    expect(r.code).toBe(0);
  });

  it('комментарий, называющий правило, — не нарушение', () => {
    const r = runHook({ 'lib/new-feature.ts': '// не await callDeepSeek(m), а водопад\n/**\n * await callOpenrouter запрещён\n */\nexport const x = 1;\n' });
    expect(r.code).toBe(0);
  });

  it('стекло поверх фото коммит не останавливает (решение 26.09)', () => {
    const r = runHook({
      'components/Hero.tsx': 'export const Hero = () => <div className="backdrop-blur-md bg-black/40 border border-white/15 rounded-2xl" />;\n',
      'components/Chip.tsx': 'export const Chip = () => <span className="bg-white/10 backdrop-blur-sm" />;\n',
    });
    expect(r.code).toBe(0);
  });

  it('устаревшие токены по-прежнему останавливают коммит', () => {
    const r = runHook({ 'components/Old.tsx': 'export const Old = () => <span className="text-premium-gold" />;\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Устаревшие токены');
  });
});
