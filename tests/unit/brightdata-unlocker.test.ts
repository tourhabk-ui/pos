/**
 * Bright Data Web Unlocker — резервный fetch для заблокированных источников.
 *
 * Владелец подключил Unlocker (zone web_unlocker2) для safety-источников,
 * которые режут наш IP. Сторож фиксирует: (1) без ключа — no-op (прямой fetch
 * не трогаем, кредиты не жжём), (2) ключ читается из env, не хардкодится,
 * (3) KVERT-синк зовёт Unlocker только как фолбэк при пустом прямом разборе.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brightDataAvailable } from '@/lib/services/ingest/brightdata-unlocker';

const helper = readFileSync(join(process.cwd(), 'lib/services/ingest/brightdata-unlocker.ts'), 'utf-8');
const sync = readFileSync(join(process.cwd(), 'lib/agents/kvert-sync.ts'), 'utf-8');

describe('reversible без ключа', () => {
  const saved = process.env.BRIGHTDATA_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.BRIGHTDATA_API_KEY;
    else process.env.BRIGHTDATA_API_KEY = saved;
  });

  it('brightDataAvailable false без ключа, true с ключом', () => {
    delete process.env.BRIGHTDATA_API_KEY;
    expect(brightDataAvailable()).toBe(false);
    process.env.BRIGHTDATA_API_KEY = 'test-key';
    expect(brightDataAvailable()).toBe(true);
  });
});

describe('ключ и эндпоинт — из env, не хардкод', () => {
  it('ключ читается из BRIGHTDATA_API_KEY', () => {
    expect(helper).toMatch(/process\.env\.BRIGHTDATA_API_KEY/);
    // Ключ не должен фигурировать литералом (только имя env).
    expect(helper).not.toMatch(/Bearer\s+[A-Za-z0-9]{12,}/);
  });
  it('zone из env с дефолтом web_unlocker2, format raw', () => {
    expect(helper).toMatch(/process\.env\.BRIGHTDATA_ZONE \|\| 'web_unlocker2'/);
    expect(helper).toMatch(/format: 'raw'/);
    expect(helper).toMatch(/api\.brightdata\.com\/request/);
  });
});

describe('KVERT зовёт Unlocker строго как фолбэк', () => {
  it('только при пустом прямом разборе И наличии ключа', () => {
    expect(sync).toMatch(/if \(parsed\.length === 0 && brightDataAvailable\(\)\)/);
  });
  it('RU-гео (иначе российский источник даст 403)', () => {
    expect(sync).toMatch(/brightDataFetch\(url, \{ country: 'ru'/);
  });
  it('путь получения данных фиксируется (direct/brightdata)', () => {
    expect(sync).toMatch(/via = 'brightdata'/);
    expect(sync).toMatch(/unmatched: \[\], via \}/);
  });
});
