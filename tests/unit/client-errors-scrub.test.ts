// @vitest-environment node
/**
 * Чистка и опознание ошибки браузера (ловушка, 13.10) — поведением на
 * граничных строках: ПД и ключи не доходят до базы, путь теряет query и
 * фрагмент, отпечаток не зависит от номеров строк, род устройства и браузера
 * выводится из заголовка без его хранения.
 */
import { describe, it, expect } from 'vitest';
import { scrubErrorText, pathOnly, errorFingerprint, classifyUserAgent } from '@/lib/client-errors/scrub';

describe('scrubErrorText', () => {
  it('почта, телефон, Bearer, ключ, query адреса и длинный hex не доходят до базы', () => {
    const raw = 'TypeError: fetch failed for ivan@example.com +7 914 123-45-67 Bearer abcdefgh12345678 '
      + 'sk-ABCDEFGHIJKLMNOP at https://vedarai.ru/api/x?secret=s3cr3t&phone=1 hash 0123456789abcdef0123456789abcdef';
    const out = scrubErrorText(raw, 1000);
    expect(out).not.toContain('ivan@example.com');
    expect(out).not.toMatch(/914 123/);
    expect(out).not.toContain('abcdefgh12345678');
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(out).not.toContain('secret=s3cr3t');
    expect(out).toContain('https://vedarai.ru/api/x');
    expect(out).not.toContain('0123456789abcdef0123456789abcdef');
    expect(out).toContain('TypeError: fetch failed');
  });

  it('режет по потолку и терпит пустоту', () => {
    expect(scrubErrorText('x'.repeat(50), 10)).toHaveLength(10);
    expect(scrubErrorText(null, 10)).toBe('');
  });
});

describe('pathOnly', () => {
  it('без query и фрагмента; абсолютный адрес — только путь; мусор — корень', () => {
    expect(pathOnly('/catalog/tours/51?secret=abc#frag')).toBe('/catalog/tours/51');
    expect(pathOnly('/request-status#k_123')).toBe('/request-status');
    expect(pathOnly('https://vedarai.ru/places/7?x=1')).toBe('/places/7');
    expect(pathOnly('javascript:void(0)')).toBe('/');
    expect(pathOnly('')).toBe('/');
  });
});

describe('errorFingerprint', () => {
  it('одна ошибка с разными номерами строк — один отпечаток; другой род — другой', () => {
    const a = errorFingerprint('error', "Cannot read properties of undefined (reading 'map')", "TypeError: x\n    at TourGrid (/_next/static/chunks/app/page-1a2b.js:12:345)");
    const b = errorFingerprint('error', "Cannot read properties of undefined (reading 'map')", "TypeError: x\n    at TourGrid (/_next/static/chunks/app/page-9z8y.js:99:1)");
    const c = errorFingerprint('unhandledrejection', "Cannot read properties of undefined (reading 'map')", undefined);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe('classifyUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'phone', 'safari'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36', 'phone', 'chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 YaBrowser/24.6 Safari/537.36', 'desktop', 'yandex'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1', 'tablet', 'safari'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/127.0', 'desktop', 'firefox'],
    ['', 'unknown', 'other'],
  ])('%s → %s / %s', (ua, device, browser) => {
    expect(classifyUserAgent(ua)).toEqual({ device, browser });
  });
});
