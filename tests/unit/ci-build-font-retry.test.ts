/**
 * CI повторяет сборку ровно один раз и ТОЛЬКО на сбое загрузки шрифта
 * Google (next/font). Любая другая ошибка сборки не повторяется — иначе
 * повтор прятал бы поломку кода.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf-8');
const step = ci.slice(ci.indexOf('- name: Build (Next.js)'), ci.indexOf('- name: Install Playwright Chromium'));

describe('ci.yml: повтор сборки только на сбое next/font', () => {
  it('шаг сборки найден', () => {
    expect(step.length).toBeGreaterThan(0);
  });

  it('повтор обусловлен маркером next/font, иная ошибка валит шаг сразу', () => {
    expect(step).toContain("grep -q 'An error occurred in `next/font`'");
    expect(step).toMatch(/if ! grep -q[^\n]*then exit 1; fi/);
  });

  it('повтор один: npm run build встречается в шаге ровно дважды', () => {
    expect(step.match(/npm run build/g)?.length).toBe(2);
  });

  it('pipefail: tee не съедает код выхода сборки', () => {
    expect(step).toContain('set -o pipefail');
  });
});
