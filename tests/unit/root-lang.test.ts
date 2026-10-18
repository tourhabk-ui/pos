/**
 * Язык документа по первому сегменту (вариант А, 19.10): <html lang> корневого
 * layout — en на /en/*, zh-CN на /zh/*, ru везде ещё. Путь layout сообщает
 * middleware заголовком x-vedar-pathname; hreflang-пары при этом уже жили в
 * посадочных (lib/seo/query-landings) и здесь не дублируются.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { htmlLangForPath, ROOT_LANG_HEADER } from '@/lib/i18n/root-lang';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('htmlLangForPath', () => {
  it('английский и китайский разделы — по первому сегменту', () => {
    expect(htmlLangForPath('/en')).toBe('en');
    expect(htmlLangForPath('/en/kamchatka-tours')).toBe('en');
    expect(htmlLangForPath('/en/bear-watching')).toBe('en');
    expect(htmlLangForPath('/zh')).toBe('zh-CN');
    expect(htmlLangForPath('/zh/booking')).toBe('zh-CN');
    expect(htmlLangForPath('/zh/tours/mestechko-dolina-geyzerov')).toBe('zh-CN');
  });

  it('похожие приставки языком не считаются', () => {
    expect(htmlLangForPath('/enough')).toBe('ru');
    expect(htmlLangForPath('/zhuk')).toBe('ru');
    expect(htmlLangForPath('/operators/en')).toBe('ru');
  });

  it('нет пути — русский, прежнее поведение', () => {
    expect(htmlLangForPath('/')).toBe('ru');
    expect(htmlLangForPath('/catalog')).toBe('ru');
    expect(htmlLangForPath(null)).toBe('ru');
    expect(htmlLangForPath(undefined)).toBe('ru');
    expect(htmlLangForPath('')).toBe('ru');
  });
});

describe('проводка: middleware → заголовок → layout', () => {
  it('middleware матчится на разделы и пишет заголовок до всякой auth-логики', () => {
    const mw = read('middleware.ts');
    expect(mw).toContain("'/en/:path*'");
    expect(mw).toContain("'/zh/:path*'");
    expect(mw).toContain(`headers.set('${ROOT_LANG_HEADER}', request.nextUrl.pathname)`);
    expect(mw.indexOf(`headers.set('${ROOT_LANG_HEADER}'`)).toBeLessThan(mw.indexOf('Redirect legacy'));
  });

  it('layout читает заголовок и ставит lang из него', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain('htmlLangForPath');
    expect(layout).toMatch(/<html lang=\{lang\}/);
    expect(ROOT_LANG_HEADER).toBe('x-vedar-pathname');
  });

  it('у английского раздела есть Content-Language, как у китайского', () => {
    const cfg = read('next.config.js');
    expect(cfg).toMatch(/source: '\/en\/:path\*',\s*headers: \[\{ key: 'Content-Language', value: 'en' \}\]/);
    expect(cfg).toMatch(/source: '\/zh\/:path\*',\s*headers: \[\{ key: 'Content-Language', value: 'zh-CN' \}\]/);
  });
});
