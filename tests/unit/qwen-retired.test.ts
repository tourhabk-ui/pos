/**
 * Модели DashScope, отключаемые Alibaba 10.10.2026 (lib/ai/qwen-retired).
 *
 * Повод (01.10): в списке оказалось зрение Кузьмича — qwen-vl-max, по §8
 * единственное зрение, достижимое с прода. Две двери выбирают модель из
 * каталога сами (резолвер «сильнейшей» и подмена при исчерпанной квоте), и
 * каталог отдаёт обречённое до последнего дня. Сторож держит обе двери и
 * умолчания: ни одно умолчание модели не может стоять на отключаемой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isQwenRetired } from '@/lib/ai/qwen-retired';
import { freeQuotaSiblings } from '@/lib/ai/qwen-free-quota';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('список отключаемых', () => {
  it('зрение qwen-vl-max и qwen-vl-plus — в списке, qwen3-vl-plus — нет', () => {
    expect(isQwenRetired('qwen-vl-max')).toBe(true);
    expect(isQwenRetired('qwen-vl-plus')).toBe(true);
    expect(isQwenRetired('qwen3-vl-plus')).toBe(false);
  });

  it('текст: qwen-plus и его алиас живы, датированные снимки — нет', () => {
    expect(isQwenRetired('qwen-plus')).toBe(false);
    expect(isQwenRetired('qwen-plus-latest')).toBe(false);
    expect(isQwenRetired('qwen-plus-2025-07-28')).toBe(true);
    expect(isQwenRetired('qwen-plus-2025-09-11')).toBe(true);
  });

  it('то, что резолвер выбрал бы при исчерпанной квоте, — в списке', () => {
    expect(isQwenRetired('qwen3.6-max-preview')).toBe(true);
    expect(isQwenRetired('qwen3-max')).toBe(true);
    expect(isQwenRetired('qwen3.8-max')).toBe(false);
  });

  it('регистр id не важен', () => {
    expect(isQwenRetired('moonshot-kimi-k2-instruct')).toBe(true);
    expect(isQwenRetired('QWEN-VL-MAX')).toBe(true);
  });
});

describe('подмена при исчерпанной квоте не уходит в отключаемое', () => {
  it('датированные снимки из списка выпадают, алиас -latest остаётся первым', () => {
    const catalog = ['qwen-plus', 'qwen-plus-latest', 'qwen-plus-2025-07-28', 'qwen-plus-2025-09-11', 'qwen-plus-2026-03-01'];
    expect(freeQuotaSiblings('qwen-plus', catalog)).toEqual(['qwen-plus-latest', 'qwen-plus-2026-03-01']);
  });
});

describe('резолвер «сильнейшей» не выбирает отключаемое', () => {
  const src = code(read('lib/ai/providers.ts'));
  it('каталог Qwen фильтруется списком до pickBestModel', () => {
    const at = src.indexOf('async function resolveBestModel');
    const body = src.slice(at, src.indexOf('pickBestModel(ids)', at));
    expect(body).toMatch(/provider === 'qwen' && isQwenRetired\(id\)/);
  });
});

describe('зрение Кузьмича', () => {
  const src = code(read('lib/ai/providers.ts'));
  it('одно умолчание на весь код, и оно не в списке', () => {
    const m = src.match(/const QWEN_VISION_DEFAULT = '([^']+)'/);
    expect(m).not.toBeNull();
    expect(isQwenRetired(m![1])).toBe(false);
  });
  it('QWEN_VISION_MODEL из списка не принимается молча: замена и строка в лог', () => {
    const at = src.indexOf('export function qwenVisionModel');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toMatch(/isQwenRetired\(env\)/);
    expect(body).toMatch(/console\.error/);
    expect(body).toMatch(/return QWEN_VISION_DEFAULT/);
  });
  it('и живой путь, и проба ai-models берут его из одного места', () => {
    expect(src).toMatch(/const model = qwenVisionModel\(\);/);
    const route = code(read('app/api/cron/ai-models/route.ts'));
    expect(route).toMatch(/qwenVisionModel\(\)/);
    expect(`${src}\n${route}`).not.toMatch(/QWEN_VISION_MODEL\s*(\?\?|\|\|)\s*'/);
  });
});

describe('ни одно умолчание модели в lib/ и app/ не стоит на отключаемой', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out); }
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }

  it('env ?? / || \'модель\' — не из списка', () => {
    const bad: string[] = [];
    for (const f of [...walk(join(process.cwd(), 'lib')), ...walk(join(process.cwd(), 'app'))]) {
      if (f.endsWith('qwen-retired.ts')) continue;
      const src = code(readFileSync(f, 'utf-8'));
      for (const m of src.matchAll(/process\.env\.[A-Z_]*MODEL[A-Z_]*\s*(?:\?\?|\|\|)\s*'([^']+)'/g)) {
        if (isQwenRetired(m[1])) bad.push(`${f.replace(process.cwd() + '/', '')}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('запасная модель решателя Qwen — не из списка', () => {
    const m = code(read('lib/ai/providers.ts')).match(/const DECISION_FALLBACK[\s\S]*?qwen: '([^']+)'/);
    expect(m).not.toBeNull();
    expect(isQwenRetired(m![1])).toBe(false);
  });
});
