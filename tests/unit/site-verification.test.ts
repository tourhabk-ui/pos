import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Тот же конвейер, которым Next превращает metadata.verification в <head>:
// сначала нормализация, потом вывод тегов. Сторож смотрит на то, что увидит
// робот вебмастера, а не на объект, который мы надеемся отдать.
import { resolveVerification } from 'next/dist/lib/metadata/resolvers/resolve-basics';
import { VerificationMeta } from 'next/dist/lib/metadata/generate/basic';
import {
  siteVerification,
  verificationTagFromEnv,
  BING_SITE_VERIFICATION,
  CHINA_VERIFICATION_SLOTS,
} from '@/lib/seo/site-verification';

/**
 * Подтверждения владения сайтом (Bing — тег владельца 15.10). Bing
 * перепроверяет тег время от времени: если он пропадёт со страницы,
 * подтверждение и отчёты вебмастера уйдут молча.
 *
 * Китайские вебмастера (находка CN-verify аудита 15.10) — из переменных
 * окружения: у Sogou и 360 код живёт 6 часов, выкат через PR не успевает.
 */

/** <head>-фрагмент подтверждений так, как его отдаст Next. */
function renderHead(env: Record<string, string | undefined>): string {
  const resolved = resolveVerification(siteVerification(env as NodeJS.ProcessEnv));
  const tags = VerificationMeta({ verification: resolved });
  return renderToStaticMarkup(createElement(Fragment, null, tags));
}

const CHINA = {
  SHENMA_SITE_VERIFICATION: 'shenma-site-verification',
  SOGOU_SITE_VERIFICATION: 'sogou_site_verification',
  TOUTIAO_SITE_VERIFICATION: 'bytedance-verification-code',
  SO360_SITE_VERIFICATION: '360-site-verification',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('подтверждение сайта для вебмастеров', () => {
  it('Bing получает свой тег msvalidate.01 — значение, присланное владельцем', () => {
    const v = siteVerification({} as NodeJS.ProcessEnv);
    expect(v.other?.['msvalidate.01']).toBe('AC1C1C2A5C527F87684D3E2571543A82');
    expect(BING_SITE_VERIFICATION).toMatch(/^[0-9A-F]{32}$/);
    expect(renderHead({})).toContain('<meta name="msvalidate.01" content="AC1C1C2A5C527F87684D3E2571543A82"/>');
  });

  it('Google и Яндекс по-прежнему из переменных окружения; без них — пусто, а не выдумка', () => {
    const withEnv = siteVerification({ GOOGLE_SITE_VERIFICATION: 'g-token', YANDEX_VERIFICATION: 'y-token' } as NodeJS.ProcessEnv);
    expect(withEnv.google).toBe('g-token');
    expect(withEnv.yandex).toBe('y-token');
    const empty = siteVerification({} as NodeJS.ProcessEnv);
    expect(empty.google).toBeUndefined();
    expect(empty.yandex).toBeUndefined();
  });

  it('реестр слотов — ровно четыре площадки с именами тегов из их форм и справок', () => {
    expect(Object.fromEntries(CHINA_VERIFICATION_SLOTS.map((s) => [s.env, s.name]))).toEqual(CHINA);
  });

  it.each(Object.entries(CHINA))('%s задана — в <head> тег %s с этим кодом', (envName, tagName) => {
    const html = renderHead({ [envName]: 'code-123' });
    expect(html).toContain(`<meta name="${tagName}" content="code-123"/>`);
    // соседние площадки без своей переменной тега не получают
    for (const [otherEnv, otherTag] of Object.entries(CHINA)) {
      if (otherEnv !== envName) expect(html).not.toContain(`name="${otherTag}"`);
    }
    // Bing не вытеснен
    expect(html).toContain('name="msvalidate.01"');
  });

  it.each(Object.entries(CHINA))('%s пуста или из пробелов — тега %s нет вовсе, не пустой content', (envName, tagName) => {
    for (const value of [undefined, '', '   ', '\n']) {
      const v = siteVerification({ [envName]: value } as NodeJS.ProcessEnv);
      expect(v.other && tagName in v.other).toBe(false);
      expect(renderHead({ [envName]: value })).not.toContain(tagName);
    }
  });

  it('пробелы вокруг кода (копирование из формы) срезаются', () => {
    expect(renderHead({ SO360_SITE_VERIFICATION: '  abc360\n' })).toContain(
      '<meta name="360-site-verification" content="abc360"/>',
    );
  });

  it('вставлен тег целиком, как показывает форма, — берётся content, а не тег внутрь content', () => {
    const html = renderHead({
      TOUTIAO_SITE_VERIFICATION: '<meta name="bytedance-verification-code" content="tt-777" />',
    });
    expect(html).toContain('<meta name="bytedance-verification-code" content="tt-777"/>');
    expect(html).not.toContain('&lt;meta');
  });

  it('имя из вставленного тега формы побеждает догадку слота (Shenma не сверен с формой)', () => {
    const html = renderHead({
      SHENMA_SITE_VERIFICATION: "<meta name='shenma_site_verification' content='sm-1'/>",
    });
    expect(html).toContain('<meta name="shenma_site_verification" content="sm-1"/>');
    expect(html).not.toContain('name="shenma-site-verification"');
  });

  it('запрет: из переменной слота нельзя поставить robots — имя не тега подтверждения отвергается', () => {
    const html = renderHead({ SOGOU_SITE_VERIFICATION: '<meta name="robots" content="noindex">' });
    expect(html).not.toContain('name="robots"');
    expect(html).toContain('<meta name="sogou_site_verification" content="noindex"/>');
  });

  it('вставлен тег без content — тега нет, и отказ назван в логе по имени переменной, без значения', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tag = verificationTagFromEnv('<meta name="360-site-verification" secret-x />', {
      env: 'SO360_SITE_VERIFICATION',
      name: '360-site-verification',
    });
    expect(tag).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('SO360_SITE_VERIFICATION');
    expect(String(warn.mock.calls[0][0])).not.toContain('secret-x');
  });

  it('запрет: корневой layout не собирает блок verification руками — только через siteVerification()', () => {
    const layout = readFileSync(join(process.cwd(), 'app/layout.tsx'), 'utf8');
    expect(layout).not.toMatch(/verification:\s*\{/);
    expect(layout).not.toMatch(
      /process\.env\.(GOOGLE_SITE_VERIFICATION|YANDEX_VERIFICATION|SHENMA_SITE_VERIFICATION|SOGOU_SITE_VERIFICATION|TOUTIAO_SITE_VERIFICATION|SO360_SITE_VERIFICATION)/,
    );
  });
});
