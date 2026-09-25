/**
 * Ссылки со страницы трафика — на саму страницу захода (владелец 25.09).
 *
 * Пути и источники в журнал пишет посетитель, поэтому сторож держит две вещи:
 * 1. ссылкой становится только путь нашего сайта и только http(s)-источник —
 *    `javascript:`, `//чужой.хост` и мусор остаются текстом;
 * 2. все списки путей на странице ведут через эту проверку, а не голым href.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { internalHref, externalHref } from '@/lib/analytics/traffic-links';

const PAGE = readFileSync(join(process.cwd(), 'app/hub/admin/traffic/page.tsx'), 'utf-8');

describe('путь сайта', () => {
  it('обычные пути — ссылка на себя', () => {
    for (const p of ['/', '/catalog/tours/27', '/routes/visitkamchatka-avacha', '/places/vodopad-spokoynyy?x=1']) {
      expect(internalHref(p), p).toBe(p);
    }
  });

  it('чужой хост, схема, пробелы и обратный слэш — не ссылка', () => {
    for (const p of ['//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'https://evil.example', 'catalog', '/a b', '/x\ny', '']) {
      expect(internalHref(p), JSON.stringify(p)).toBeNull();
    }
  });
});

describe('источник перехода', () => {
  it('http(s) — ссылка', () => {
    expect(externalHref('https://yandex.ru/')).toBe('https://yandex.ru/');
    expect(externalHref('http://yandex.ru/searchapp?text=')).toBe('http://yandex.ru/searchapp?text=');
  });

  it('прочие схемы и не-адреса — текст', () => {
    for (const r of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '(direct)', 'yandex.ru', '']) {
      expect(externalHref(r), r).toBeNull();
    }
  });
});

describe('подключено на странице', () => {
  it('пути во всех списках идут через PathLink, а не голым текстом', () => {
    // Топ страниц, карта переходов (оба конца), поведение, уходы, 404.
    expect((PAGE.match(/<PathLink path=\{/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(PAGE).toContain('const href = internalHref(path);');
    expect(PAGE).not.toMatch(/href=\{(p\.path|e\.from|e\.to|n\.path)\}/);
  });

  it('источник — через externalHref и без передачи реферера', () => {
    expect(PAGE).toContain('const href = externalHref(r.referrer);');
    expect(PAGE).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(PAGE).not.toMatch(/href=\{r\.referrer\}/);
  });

  it('тур в воронке ведёт на единственную карточку тура', () => {
    expect(PAGE).toContain('href={`/marketplace/tours/${f.tourId}`}');
  });

  it('открывается в новой вкладке — сводка остаётся', () => {
    expect((PAGE.match(/target="_blank"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
