import { describe, it, expect } from 'vitest';
import { SSR_PROBES, formatSentinelAlert } from '@/lib/seo/ssr-sentinel';

function probe(path: string) {
  const p = SSR_PROBES.find((x) => x.path === path);
  if (!p) throw new Error(`нет пробы для ${path}`);
  return p;
}

describe('SSR-сторож: сигналы контента в первом HTML', () => {
  it('/routes: ItemList JSON-LD присутствует — ok', () => {
    const html = '<html><script type="application/ld+json">{"@type":"ItemList"}</script></html>';
    expect(probe('/routes').check(html).ok).toBe(true);
  });

  it('/routes: пустой каркас без ItemList — провал (регрессия шага 3)', () => {
    const html = '<html><div id="__next">0 природных мест</div></html>';
    const r = probe('/routes').check(html);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('ItemList');
  });

  it('/operators: карточки операторов в HTML — ok', () => {
    const html = '<a href="/operators/kamchatskaya-rybalka">Оператор</a>';
    expect(probe('/operators').check(html).ok).toBe(true);
  });

  it('/operators: ссылка без slug (сам листинг) не считается карточкой', () => {
    const html = '<a href="/operators">Операторы</a>';
    expect(probe('/operators').check(html).ok).toBe(false);
  });

  it('/catalog: ссылки на туры (catalog и marketplace-варианты) — ok', () => {
    expect(probe('/catalog').check('<a href="/catalog/tours/30">Тур</a>').ok).toBe(true);
    expect(probe('/catalog').check('<a href="/marketplace/tours/30">Тур</a>').ok).toBe(true);
  });

  it('/catalog: каркас без туров — провал', () => {
    expect(probe('/catalog').check('<div>Загрузка…</div>').ok).toBe(false);
  });

  it('главная: живой лейбл StatsBand — ok, без него — провал', () => {
    expect(probe('/').check('<span>локаций с координатами</span>').ok).toBe(true);
    expect(probe('/').check('<span>778 локаций</span>').ok).toBe(false);
  });

  it('алерт перечисляет только провалившиеся пробы с путями', () => {
    const text = formatSentinelAlert(
      [{ name: 'Листинг операторов', path: '/operators', ok: false, detail: 'карточек операторов: 0 (ожидание >=1)' }],
      'https://vedarai.ru'
    );
    expect(text).toContain('Листинг операторов');
    expect(text).toContain('https://vedarai.ru/operators');
    expect(text).toContain('карточек операторов: 0');
    expect(text).not.toContain('Каталог туров');
  });
});
