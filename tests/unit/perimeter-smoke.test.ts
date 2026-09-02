/**
 * Сторож исполняемого критерия «периметр закрыт».
 *
 * Скрипт scripts/ci/perimeter-smoke.sh исполняется здесь с ПОДМЕНЁННЫМ curl:
 * фальшивый curl отвечает кодом по адресу, а скрипт судит. Так проверяется
 * не «строка есть в файле», а решение: расхождение красит, недозвон даёт
 * отдельный код 2 и зелёным не считается (§4.0 — три исхода).
 *
 * Ловушка «exit code конвейера» (01.09): `bash x.sh | tee` берёт код tee.
 * Workflow обязан снимать PIPESTATUS — это тоже проверяется.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/ci/perimeter-smoke.sh');

/** Фальшивый curl: код по подстроке адреса из переменных FAKE_*; иначе 000. */
function fakeCurl(codes: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'perimeter-'));
  const p = join(dir, 'curl');
  const cases = Object.entries(codes)
    .map(([needle, code]) => `  case "$url" in *"${needle}"*) printf '${code}'; exit 0;; esac`)
    .join('\n');
  writeFileSync(p, `#!/usr/bin/env bash
url=""
for a in "$@"; do url="$a"; done
${cases}
printf '000'
exit 7
`);
  chmodSync(p, 0o755);
  return p;
}

function run(codes: Record<string, string>) {
  const r = spawnSync('bash', [SCRIPT], {
    env: { ...process.env, CURL: fakeCurl(codes), BASE_URL: 'https://example.test' },
    encoding: 'utf8',
  });
  return { rc: r.status, out: r.stdout + r.stderr };
}

const GOOD = {
  '/api/admin/health': '401',
  '/api/admin/operators/create': '403',
  'debug-waterfall?check=env': '404',
  'debug-waterfall': '404',
  '/api/cron/watchdog': '401',
  '/api/safety/sos': '405',
  '/api/push/subscribe': '400',
  '/api/mcp': '200',
};

describe('perimeter-smoke.sh: три исхода', () => {
  it('всё сошлось — 0', () => {
    const { rc, out } = run(GOOD);
    expect(out).toContain('соответствует обещанному');
    expect(rc).toBe(0);
  });

  it('admin отвечает 200 анониму — 1, строка названа', () => {
    const { rc, out } = run({ ...GOOD, '/api/admin/health': '200' });
    expect(rc).toBe(1);
    expect(out).toMatch(/kuzmich-grounding.*РАСХОЖДЕНИЕ/);
  });

  it('Edge режет push-подписку 401 — 1 (открытое обещано открытым)', () => {
    const { rc, out } = run({ ...GOOD, '/api/push/subscribe': '401' });
    expect(rc).toBe(1);
    expect(out).toMatch(/push\/subscribe.*РАСХОЖДЕНИЕ/);
  });

  it('не дозвонились до одной строки — 2, не 0 и не 1', () => {
    const { rc, out } = run({ ...GOOD, '/api/mcp': '000' });
    expect(rc).toBe(2);
    expect(out).toContain('НЕ СМОГЛИ ПРОВЕРИТЬ');
    expect(out).toContain('Зелёным не считать');
  });

  it('до прода не достали вовсе — 2', () => {
    const { rc } = run({});
    expect(rc).toBe(2);
  });
});

describe('workflow периметра', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/perimeter-smoke.yml'), 'utf8');

  it('зовёт скрипт и снимает код через PIPESTATUS, а не через tee', () => {
    expect(wf).toContain('scripts/ci/perimeter-smoke.sh');
    expect(wf).toMatch(/PIPESTATUS\[0\]/);
    expect(wf).toMatch(/exit "\$rc"/);
  });

  it('права объявлены, только чтение', () => {
    expect(wf).toMatch(/^permissions:\n  contents: read$/m);
  });

  it('маркер запуска существует', () => {
    const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/perimeter-smoke.json'), 'utf8')) as { run: number };
    expect(marker.run).toBeGreaterThan(0);
  });
});
