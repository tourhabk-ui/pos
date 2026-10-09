// @vitest-environment node
/**
 * Ленивые короткие клипы «красота и движ» (components/media/LazyClip,
 * lib/media/clip-policy).
 *
 * Клип — украшение: он обязан уступать человеку, сети и батарее. Сторож
 * держит и решение (чистая политика), и то, что компонент ему подчиняется, а
 * не играет «всегда», и что файл не качается, пока клип далеко от экрана.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { clipHint, clipPolicy, type ClipEnv } from '@/lib/media/clip-policy';
import { LazyClip } from '@/components/media/LazyClip';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
const GOOD: ClipEnv = { reducedMotion: false, saveData: false, effectiveType: '4g', online: true };

describe('когда клип играет сам', () => {
  it('хорошая сеть, движение не просили — играет', () => {
    expect(clipPolicy(GOOD)).toEqual({ autoplay: true, reason: 'ok' });
  });

  it.each([
    ['reduced-motion', { ...GOOD, reducedMotion: true }],
    ['save-data', { ...GOOD, saveData: true }],
    ['slow-network', { ...GOOD, effectiveType: '3g' }],
    ['slow-network', { ...GOOD, effectiveType: '2g' }],
    ['slow-network', { ...GOOD, effectiveType: 'slow-2g' }],
    ['offline', { ...GOOD, online: false }],
  ] as const)('%s — не играет', (reason, env) => {
    expect(clipPolicy(env)).toEqual({ autoplay: false, reason });
  });

  it('офлайн сильнее прочего: играть нечему, даже если человек просил', () => {
    expect(clipPolicy({ ...GOOD, online: false, reducedMotion: true }).reason).toBe('offline');
  });

  it('браузер не сообщает тип сети (Safari, Firefox) — это не запрет', () => {
    expect(clipPolicy({ reducedMotion: false, saveData: false, online: true })).toEqual({ autoplay: true, reason: 'ok' });
    expect(clipPolicy({ ...GOOD, effectiveType: 'неведомо' }).autoplay).toBe(true);
  });

  it('человеку объясняется, почему клип стоит; когда играет — молчим', () => {
    expect(clipHint('ok')).toBeNull();
    for (const r of ['offline', 'save-data', 'slow-network', 'reduced-motion'] as const) {
      expect(clipHint(r), r).toMatch(/\S/);
    }
    expect(clipHint('offline')).toMatch(/Нет сети/);
  });
});

describe('компонент ленив по построению', () => {
  const html = renderToStaticMarkup(
    createElement(LazyClip, { url: '/video/x/a.mp4', poster: '/video/x/a.poster.jpg', label: 'Подход' }),
  );
  const tag = html.match(/<video[^>]*>/)![0];

  it('до подхода к экрану: обложка и preload="none", ни src, ни source, ни автоигры', () => {
    expect(tag).toContain('poster="/video/x/a.poster.jpg"');
    expect(tag).toContain('preload="none"');
    expect(tag).not.toContain('src=');
    expect(html).not.toContain('<source');
    expect(tag).not.toMatch(/autoplay/i);
  });

  it('без звука, петля, внутри страницы (не на весь экран), с названием для скринридера', () => {
    expect(tag).toContain('muted');
    expect(tag).toContain('loop');
    expect(tag).toContain('playsinline');
    expect(tag).toContain('aria-label="Подход"');
    expect(tag).not.toContain('controls');
  });

  it('есть кнопка «играть» — клип доступен и тем, кому автоигра запрещена', () => {
    expect(html).toContain('aria-label="Воспроизвести: Подход"');
  });
});

describe('поведение закреплено в исходнике', () => {
  const src = read('components/media/LazyClip.tsx');

  it('файл подключается у экрана (запас 300 px), играет при видимости не меньше половины, невидимое ставится на паузу', () => {
    expect(src).toMatch(/rootMargin: '300px'/);
    expect(src).toMatch(/intersectionRatio >= 0\.5/);
    expect(src).toMatch(/v\.pause\(\)/);
    expect(src).toMatch(/wantsFile = tapped \|\| \(auto && near\)/);
    expect(src).toMatch(/src=\{wantsFile && !offline \? url : undefined\}/);
  });

  it('подчиняется политике: reduced-motion, экономия трафика, тип сети, офлайн', () => {
    expect(src).toMatch(/prefers-reduced-motion: reduce/);
    expect(src).toMatch(/connection\?\.saveData/);
    expect(src).toMatch(/connection\?\.effectiveType/);
    expect(src).toMatch(/navigator\.onLine/);
    expect(src).toMatch(/clipPolicy\(/);
  });

  it('нет IntersectionObserver — не гадаем: обложка и кнопка', () => {
    expect(src).toMatch(/typeof IntersectionObserver !== 'undefined'/);
    expect(src).toMatch(/const auto = verdict\?\.autoplay === true && hasObserver/);
  });

  it('никаких @keyframes и хардкод-цветов: подложка кнопки — чёрная альфа поверх видео', () => {
    expect(src).not.toMatch(/@keyframes|#[0-9a-fA-F]{3,6}\b/);
  });

  it('политика чистая: ни браузера, ни сети', () => {
    const p = read('lib/media/clip-policy.ts');
    expect(p).not.toMatch(/window\.|navigator\.|document\.|fetch\(/);
  });
});
