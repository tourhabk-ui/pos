/**
 * Сторож «Летописи Камчатки» (решение владельца 03.10): статья — справка по
 * источникам, открывается своей страницей, доступна из навигации и sitemap.
 *
 * Повод — заметка на карточке Батареи Максутова: от первого лица, с
 * выдуманной «плитой на валуне» и «12 нижними чинами». Поэтому у статьи
 * обязаны быть названные источники и голос справки, а не путевой заметки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHRONICLE_ARTICLES, CHRONICLE_BY_SLUG, chronicleForPlace, articleKind, articlesByKind } from '@/lib/chronicle/articles';
import { ARTICLE_KINDS, TOPONYM_SECTIONS, isHedged } from '@/lib/chronicle/kinds';
import { descriptionVoice } from '@/lib/places/description-voice';

const ROOT = process.cwd();
const text = (slug: string) => CHRONICLE_BY_SLUG[slug].sections
  .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
  .join('\n');

describe('статьи летописи', () => {
  it('адреса уникальны и годятся для ссылки', () => {
    const slugs = CHRONICLE_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });

  for (const a of CHRONICLE_ARTICLES) {
    it(`${a.slug}: у статьи названы источники со ссылками`, () => {
      expect(a.sources.length).toBeGreaterThan(0);
      for (const s of a.sources) expect(s.url).toMatch(/^https:\/\//);
      // Адрес источника — ключ строки списка на странице.
      expect(new Set(a.sources.map((s) => s.url)).size).toBe(a.sources.length);
    });

    it(`${a.slug}: голос справки, не путевой заметки`, () => {
      // Цитаты участников — от первого лица по природе; судится текст статьи.
      const own = a.sections.flatMap((s) => s.paragraphs.filter((p): p is string => typeof p === 'string')).join('\n');
      expect(descriptionVoice(own).voice).toBe('plain');
    });

    it(`${a.slug}: дата сверки — настоящая дата`, () => {
      expect(Number.isNaN(Date.parse(a.checkedAt))).toBe(false);
    });

    it(`${a.slug}: без эмодзи`, () => {
      expect(text(a.slug)).not.toMatch(/\p{Extended_Pictographic}/u);
    });
  }

  it('оборона 1854 связана с Батареей Максутова и Никольской сопкой', () => {
    expect(chronicleForPlace('a2b3c4d5-e6f7-4890-bcde-f01234567890').map((a) => a.slug))
      .toContain('petropavlovskaya-oborona-1854');
    expect(chronicleForPlace('51598b80-6b92-48d9-beb4-019f824524c9').length).toBeGreaterThan(0);
  });

  it('маяк связан с местом «Маяк Петропавловский»; две даты основания названы обе', () => {
    expect(chronicleForPlace('0aa97c3c-c4d7-496d-a879-7fa065d7f8de').map((a) => a.slug))
      .toContain('petropavlovskiy-mayak');
    const t = text('petropavlovskiy-mayak');
    expect(t).toContain('1738–1740');
    expect(t).toContain('1 июля 1850');
  });

  it('цунами 1952: число погибших дано всеми оценками, а не одной', () => {
    const t = text('severo-kurilskoe-cunami-1952');
    for (const n of ['1200', '2336', '4000', '14 000']) expect(t).toContain(n);
    expect(chronicleForPlace('34785d3a-1b13-4390-86b8-9c83ea234724').length).toBeGreaterThan(0);
  });

  it('Шумшу: итоговые потери обеих сторон из источника', () => {
    const t = text('vzyatie-shumshu-1945');
    expect(t).toContain('1567');
    expect(t).toContain('1018');
  });

  it('Большерецкий маяк связан с местом каталога', () => {
    expect(chronicleForPlace('f970acdd-e9f4-44f9-a678-279c0efe2c68').map((a) => a.slug)).toContain('bolsheretskiy-mayak');
  });

  it('Дмитрий Максутов — младший брат Александра (источник), не наоборот', () => {
    expect(text('petropavlovskaya-oborona-1854')).toContain('Александр Максутов, старший брат Дмитрия');
  });

  // Черновики агента-летописца 03.10 (docs/chronicle/AGENT_PROMPT.md):
  // статья связана со своим местом, ключевое число таблицы фактов — в тексте.
  it('основание Петропавловска связано с памятником Берингу; обе даты переноса памятника названы', () => {
    expect(chronicleForPlace('c4d5e6f7-a8b9-4012-defa-123456789012').map((a) => a.slug))
      .toContain('osnovanie-petropavlovska-1740');
    const t = text('osnovanie-petropavlovska-1740');
    expect(t).toContain('17 октября');
    expect(t).toContain('16 октября 1945');
    expect(t).toContain('1946');
  });

  it('маяк Станицкого связан с местом; дата каменной башни и дальность огня 1956 года', () => {
    expect(chronicleForPlace('efebd626-8fce-48d5-8d6d-b1db7149d270').map((a) => a.slug)).toContain('mayak-stanitskogo');
    const t = text('mayak-stanitskogo');
    expect(t).toContain('7 декабря 1953');
    expect(t).toContain('20 миль');
  });

  it('Никольское связано с тремя зданиями; аренда 1871–1891 и число шкур из источника', () => {
    for (const id of ['583c8f78-d82d-4021-8b59-84c8616065b0', '4c6fc28d-9158-4e9a-8889-f4a817406b85', 'd851e5bb-e21a-4a07-90b2-165969fe34a8']) {
      expect(chronicleForPlace(id).map((a) => a.slug)).toContain('nikolskoe-i-komandory');
    }
    const t = text('nikolskoe-i-komandory');
    expect(t).toContain('1826');
    expect(t).toContain('1871');
    expect(t).toContain('769 893');
  });

  it('«Ниитака»: число погибших дано обеими версиями — 284 и 328', () => {
    expect(chronicleForPlace('9545339a-8dd2-44a1-9439-4bc150162dc1').map((a) => a.slug)).toContain('gibel-kreysera-niitaka-1922');
    const t = text('gibel-kreysera-niitaka-1922');
    expect(t).toContain('284');
    expect(t).toContain('328');
    expect(t).toContain('26 августа 1922');
  });

  it('Северо-Курильск связан с кладбищем кораблей и остовом; 28 объектов 2024 года и 1898', () => {
    for (const id of ['5056db1d-9180-4a26-9dc3-427572c93b7f', 'cf5695b1-429c-4658-a9a2-32c206599f30']) {
      expect(chronicleForPlace(id).map((a) => a.slug)).toContain('severo-kurilsk-kasivabara-i-korabli');
    }
    const t = text('severo-kurilsk-kasivabara-i-korabli');
    expect(t).toContain('1898');
    expect(t).toContain('28 затонувших объектов');
  });

  it('Беринг связан с памятником; даты смерти и выхода к Америке из источника', () => {
    expect(chronicleForPlace('c4d5e6f7-a8b9-4012-defa-123456789012').map((a) => a.slug)).toContain('vitus-bering-kamchatskie-ekspedicii');
    const t = text('vitus-bering-kamchatskie-ekspedicii');
    expect(t).toContain('8 (19) декабря 1741');
    expect(t).toContain('16 июля 1741');
  });

  it('Крашенинников: четыре года на Камчатке и 25 773 версты', () => {
    expect(chronicleForPlace('20d7b84d-8145-48a3-9177-3d7f40ec9915').map((a) => a.slug)).toContain('krasheninnikov-opisanie-zemli-kamchatki');
    const t = text('krasheninnikov-opisanie-zemli-kamchatki');
    expect(t).toContain('1737 по 1741');
    expect(t).toContain('25 773');
  });

  it('Паратунка: связана с источниками; версия шамана и расхождение «ительменский / айнский»', () => {
    expect(chronicleForPlace('af073d1b-d101-4fce-9197-4ea6a84340af').map((a) => a.slug)).toContain('toponim-paratunka');
    const t = text('toponim-paratunka');
    expect(t).toContain('Паратун — ительменского шамана');
    expect(t).toContain('айнского');
  });

  it('Налычево: связано с парком; версия имени от ительмена Налачь Тынбалова', () => {
    expect(chronicleForPlace('ce59fcc5-0e85-487c-9acf-5cbbb46d2e1e').map((a) => a.slug)).toContain('toponim-nalychevo');
    expect(text('toponim-nalychevo')).toContain('Налачь Тынбалова');
  });
});


describe('каркас серии: роды статей', () => {
  it('у каждой статьи известный род, оглавление покрывает все статьи', () => {
    for (const a of CHRONICLE_ARTICLES) expect(Object.keys(ARTICLE_KINDS)).toContain(articleKind(a));
    const listed = articlesByKind().flatMap((g) => g.articles.map((a) => a.slug));
    expect(listed.sort()).toEqual(CHRONICLE_ARTICLES.map((a) => a.slug).sort());
  });

  for (const a of CHRONICLE_ARTICLES.filter((x) => articleKind(x) === 'toponym')) {
    it(`${a.slug}: топоним — обязательные секции и слово-ограничитель`, () => {
      const headings = a.sections.map((s) => s.heading);
      for (const h of TOPONYM_SECTIONS) expect(headings).toContain(h);
      // Этимология без «предположительно» — уверенный тон там, где источник
      // не уверен; в лиде тоже нельзя выбирать версию.
      expect(isHedged(text(a.slug))).toBe(true);
      expect(isHedged(a.lead)).toBe(true);
      expect(a.placeIds.length).toBeGreaterThan(0);
    });
  }

  it('сторож топонима краснеет на уверенном тексте', () => {
    expect(isHedged('Название означает «отец заливов».')).toBe(false);
    expect(isHedged('Название предположительно от ительменского «эвыч».')).toBe(true);
  });
});

describe('страницы, навигация и sitemap', () => {
  it('оглавление и страница статьи существуют', () => {
    expect(existsSync(join(ROOT, 'app/letopis/page.tsx'))).toBe(true);
    expect(existsSync(join(ROOT, 'app/letopis/[slug]/page.tsx'))).toBe(true);
  });

  it('раздел есть в навигации и в sitemap', () => {
    expect(readFileSync(join(ROOT, 'lib/navigation/platform-links.ts'), 'utf-8')).toContain("href: '/letopis'");
    const sm = readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf-8');
    expect(sm).toContain('/letopis');
    expect(sm).toContain('CHRONICLE_ARTICLES.map');
  });

  it('карточка места ведёт на статью', () => {
    expect(readFileSync(join(ROOT, 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8')).toMatch(/href=\{`\/letopis\/\$\{c\.slug\}`\}/);
  });
});
