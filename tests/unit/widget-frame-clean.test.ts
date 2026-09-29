/**
 * Виджет партнёра (iframe на чужом сайте) несёт только чат или форму.
 *
 * Примерка на fishingkam.ru 29.09: `/widget/*` рендерились корневым layout, и
 * в чужой сайт уезжало всё, что layout вешает на каждую страницу Ведара.
 * StickyLeadButton ложился поверх кнопки отправки в чате и полей формы,
 * баннер согласия закрывал имя и телефон, Метрика и `/api/analytics/hit`
 * писали визит Ведару за каждый просмотр страницы партнёра, service worker
 * ставился каждому его посетителю.
 *
 * Сторож держит связку целиком: КАЖДЫЙ компонент, которого layout (и
 * Providers) монтирует на все страницы, обязан либо спрашивать
 * `isWidgetPath`, либо стоять в исключениях с причиной. Новый глобальный
 * компонент без ответа — красный: молчание не ответ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isWidgetPath } from '@/lib/embed/widget-frame';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Безвредны внутри iframe — с причиной, почему. */
const HARMLESS_IN_WIDGET: Record<string, string> = {
  Providers: 'обёртка контекстов; то, что она монтирует сама, проверяется ниже отдельно',
  OfflineBanner: 'показывается только без сети — и тогда говорит правду о том, почему чат не отвечает',
  GlobalSearchModal: 'открывается только действием человека, само ничего не рисует',
  LastPositionTracker: 'читает позицию, только если доступ уже выдан; чужому iframe браузер его не выдаёт',
  ReferralCapture: 'читает ?ref собственного адреса; у адреса виджета его нет',
  InstallTracker: 'слушает appinstalled и standalone-запуск — внутри iframe их не бывает',
  Toaster: 'рисует только всплывашки, которые кто-то вызвал; сам по себе пуст',
};

/** Контексты Providers — не рисуют ничего и не шлют запросов сами по себе. */
const CONTEXT_PROVIDER = /Provider$/;

/** Компоненты, что монтируются на каждой странице: <Tag /> внутри <body>. */
function bodyTags(src: string): string[] {
  const body = src.slice(src.indexOf('<body'), src.indexOf('</body>'));
  return [...new Set([...body.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map(m => m[1]))];
}

function moduleOf(src: string, tag: string): string {
  const re = new RegExp(`import\\s+(?:\\{[^}]*\\b${tag}\\b[^}]*\\}|${tag})\\s+from\\s+'@/([^']+)'`);
  const m = src.match(re);
  if (!m) throw new Error(`не найден импорт ${tag}`);
  const base = m[1];
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (existsSync(join(ROOT, base + ext))) return base + ext;
  }
  throw new Error(`не найден файл ${base}`);
}

describe('isWidgetPath', () => {
  it('узнаёт чат и форму заявки', () => {
    expect(isWidgetPath('/widget/fishingkam')).toBe(true);
    expect(isWidgetPath('/widget/lead-form/fishingkam')).toBe(true);
    expect(isWidgetPath('/widget')).toBe(true);
  });
  it('не путает с похожими адресами Ведара', () => {
    expect(isWidgetPath('/widgets')).toBe(false);
    expect(isWidgetPath('/hub/admin/widget')).toBe(false);
    expect(isWidgetPath('/')).toBe(false);
    expect(isWidgetPath(null)).toBe(false);
  });
});

describe('глобальные компоненты молчат внутри виджета', () => {
  const layout = read('app/layout.tsx');
  const providers = read('components/Providers.tsx');
  // Providers монтирует свои компоненты на каждой странице так же, как layout:
  // перепись идёт по ВСЕМ его тегам, а не по одному PageViewTracker. Контексты
  // (*Provider) ничего не рисуют; Toaster берётся из пакета — он в исключениях.
  const providerTags = [...new Set([...providers.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map(m => m[1]))]
    .filter(tag => !CONTEXT_PROVIDER.test(tag));
  const mounted = [
    ...bodyTags(layout).map(tag => ({ tag, file: moduleOf(layout, tag) })),
    ...providerTags.map(tag => ({ tag, file: HARMLESS_IN_WIDGET[tag] ? '' : moduleOf(providers, tag) })),
  ];

  it('layout монтирует то, что сторож ожидает увидеть (перепись не пуста)', () => {
    const tags = mounted.map(m => m.tag);
    for (const t of ['ThirdPartyScripts', 'StickyLeadButton', 'ServiceWorkerRegistrar', 'PageViewTracker']) {
      expect(tags).toContain(t);
    }
  });

  for (const { tag, file } of mounted) {
    it(`${tag}: спрашивает isWidgetPath или записан безвредным с причиной`, () => {
      if (HARMLESS_IN_WIDGET[tag]) {
        expect(HARMLESS_IN_WIDGET[tag].length).toBeGreaterThan(20);
        return;
      }
      const src = read(file);
      expect(src, `${file} должен спрашивать isWidgetPath`).toMatch(/isWidgetPath\(/);
      expect(src).toMatch(/from '@\/lib\/embed\/widget-frame'/);
    });
  }

  it('исключения не протухают: каждое ещё смонтировано в layout', () => {
    const tags = new Set(mounted.map(m => m.tag));
    for (const name of Object.keys(HARMLESS_IN_WIDGET)) {
      expect(tags.has(name), `${name} больше не монтируется — убери из исключений`).toBe(true);
    }
  });

  it('счётчики и баннер согласия не рендерятся в виджете', () => {
    const tps = read('components/legal/ThirdPartyScripts.tsx');
    expect(tps).toMatch(/if \(isWidgetPath\(pathname\)\) return null;/);
    const pv = read('components/shared/PageViewTracker.tsx');
    expect(pv).toMatch(/if \(isWidgetPath\(pathname\)\) return;[\s\S]*\/api\/analytics\/hit/);
  });

  it('service worker в виджете не регистрируется', () => {
    const sw = read('components/PWA/ServiceWorkerRegistrar.tsx');
    expect(sw).toMatch(/if \(isWidgetPath\(window\.location\.pathname\)\) return;[\s\S]*serviceWorker[\s\S]*\.register\(/);
  });
});
