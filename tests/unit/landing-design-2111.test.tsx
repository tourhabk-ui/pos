/**
 * Оформление посадочных по ТЗ Сыщика 21.11 (lib/landings/design,
 * components/landings/Landing*): сторож того, что оформление только
 * оборачивает готовый текст и берёт кадры по правилам владельца.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup } from '@testing-library/react';

import { LANDINGS, landingBySlug } from '@/lib/landings/landings';
import { parseArticleMarkdown, inlineText, type Block } from '@/lib/articles/markdown';
import {
  LANDING_DESIGN, allLandingPhotos, landingDesign, landingOgImagePath, REVIEWED_TOUR_COVERS, reviewedTourCover,
} from '@/lib/landings/design';
import { operatorPausedOnTourBlocks } from '@/lib/operators/site-pause';
import { calloutFor } from '@/components/landings/LandingBody';
import { LandingContent, landingJsonLd } from '@/components/landings/LandingContent';
import { LandingHero } from '@/components/landings/LandingMedia';
import { landingPageMetadata } from '@/components/landings/LandingPage';
import type { LandingBlockTour } from '@/lib/landings/tours';

afterEach(cleanup);

const MANIFEST = new Set(
  (JSON.parse(readFileSync(join(process.cwd(), 'lib/images/photo-variants.json'), 'utf8')) as Array<{ src: string }>).map((e) => e.src),
);
const blocksOf = (slug: string): Block[] => {
  const l = landingBySlug(slug);
  return [...parseArticleMarkdown(l.before), ...parseArticleMarkdown(l.after)];
};
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/ ([.,;:!?»)])/g, '$1').trim();

describe('реестр оформления', () => {
  it('ключи — существующие посадочные', () => {
    const slugs = new Set(LANDINGS.map((l) => l.slug));
    for (const k of Object.keys(LANDING_DESIGN)) expect(slugs.has(k), k).toBe(true);
  });

  it('каждый цветной блок находит ровно один абзац своей страницы', () => {
    for (const [slug, d] of Object.entries(LANDING_DESIGN)) {
      const ps = blocksOf(slug).filter((b) => b.t === 'p');
      for (const c of d.callouts ?? []) {
        const hits = ps.filter((b) => inlineText((b as Extract<Block, { t: 'p' }>).c).startsWith(c.starts));
        expect(hits.length, `${slug}: «${c.starts}»`).toBe(1);
        expect(calloutFor(hits[0], d.callouts ?? [])).toBe(c);
      }
    }
  });

  it('фото в тексте стоит перед существующим H2', () => {
    for (const [slug, d] of Object.entries(LANDING_DESIGN)) {
      const h2 = blocksOf(slug).filter((b) => b.t === 'h2').map((b) => (b as Extract<Block, { t: 'h2' }>).text);
      for (const f of d.figures ?? []) expect(h2, `${slug}: ${f.beforeH2}`).toContain(f.beforeH2);
    }
  });

  it('кадры: свои адреса, с подписью автора, ничего от операторов на паузе', () => {
    const photos = allLandingPhotos();
    expect(photos.length).toBeGreaterThan(20);
    for (const { slug, photo } of photos) {
      const where = `${slug}: ${photo.src}`;
      expect(photo.src, where).toMatch(/^\/(images\/|api\/images\/(route|place-gallery|s3\/photos)\/)/);
      expect(photo.src, where).not.toMatch(/mestechko/i);
      if (photo.src.startsWith('/images/')) expect(MANIFEST.has(photo.src), where).toBe(true);
      expect(photo.credit.name.length, where).toBeGreaterThan(2);
      expect(photo.alt.length, where).toBeGreaterThan(5);
      expect(photo.width > 0 && photo.height > 0, where).toBe(true);
      if (photo.credit.operator) {
        expect(operatorPausedOnTourBlocks(photo.credit.operator), where).toBe(false);
        expect(photo.credit.href, where).toBe(`/operators/${photo.credit.operator}`);
        expect(photo.src, where).toContain(`/s3/photos/${photo.credit.operator}/`);
      }
    }
  });

  it('обложки туров — только просмотренные, не от операторов на паузе, и та же, что в базе', () => {
    for (const [slug, src] of Object.entries(REVIEWED_TOUR_COVERS)) {
      expect(slug).not.toMatch(/mestechko/);
      expect(src).toMatch(/^\/api\/images\/s3\/photos\//);
      expect(src).not.toMatch(/mestechko/);
    }
    const [slug, src] = Object.entries(REVIEWED_TOUR_COVERS)[0];
    expect(reviewedTourCover(slug, `https://vedarai.ru${src}`)).toBe(src);
    expect(reviewedTourCover(slug, '/api/images/s3/photos/other/new-cover.jpg')).toBeNull();
    expect(reviewedTourCover('neizvestnyj', src)).toBeNull();
  });
});

describe('кадр «Раздолья Камчатки» (владелец 26.11)', () => {
  // Обложка тура «Лагуны» «Зеленовские озерки» снята не на озерках:
  // «на месте зеленовских озерков фото Раздолья камчатки».
  const RAZDOLYE = '/api/images/s3/photos/laguna-expedition/zelenovskie-ozerki-cover.jpg';

  it('не подписан как Зеленовские озерки ни на одной посадочной', () => {
    for (const { slug, photo } of allLandingPhotos()) {
      if (photo.src !== RAZDOLYE) continue;
      expect(`${photo.caption} ${photo.alt}`, slug).not.toMatch(/зеленовск/i);
    }
  });

  it('героем страницы озерков стоит снимок самого озера, подпись автора — его имя', () => {
    const hero = landingDesign('zelenovskie-ozerki').hero!;
    expect(hero.src).not.toBe(RAZDOLYE);
    expect(hero.src).toMatch(/^\/api\/images\/s3\/photos\/zaporozhets\/zelenovskie-ozerki-/);
    expect(hero.credit.name).toBe('Андрей Запорожец');
    const { container } = render(<LandingHero h1="Зеленовские озерки" photo={hero} />);
    expect(container.textContent).toContain('Андрей Запорожец');
    expect(container.innerHTML).not.toContain('laguna-expedition/zelenovskie-ozerki-cover');
  });
});

describe('страница', () => {
  it('у каждой посадочной текст не потерян: все абзацы, пункты и ответы FAQ в HTML', () => {
    for (const l of LANDINGS) {
      const { container } = render(<LandingContent landing={l} tours={[]} showH1={false} kuzmich />);
      const html = norm((container.textContent ?? '').replace(/\s*\[\d+\]/g, ''));
      for (const b of blocksOf(l.slug)) {
        const parts: string[] =
          b.t === 'p' ? [inlineText(b.c)]
          : b.t === 'ul' || b.t === 'ol' ? b.items.map((it) => inlineText(it))
          : b.t === 'qa' ? [inlineText(b.q), ...b.a.map((p) => inlineText(p))]
          : [];
        for (const p of parts) expect(html, `${l.slug}: ${p.slice(0, 60)}`).toContain(norm(p));
      }
      cleanup();
    }
  });

  it('FAQ — <details>/<summary>, первый раскрыт, ответы в разметке', () => {
    const { container } = render(<LandingContent landing={landingBySlug('kamchatka-s-detmi')} tours={[]} showH1={false} />);
    const d = [...container.querySelectorAll('details.landing-faq')];
    expect(d.length).toBeGreaterThan(2);
    expect(d[0].hasAttribute('open')).toBe(true);
    expect(d[1].hasAttribute('open')).toBe(false);
    for (const x of d) {
      expect(x.querySelector('summary h3')).toBeTruthy();
      expect((x.querySelector('.landing-faq-a')?.textContent ?? '').length).toBeGreaterThan(10);
    }
  });

  it('оглавление со стабильными якорями и Кузьмич перед «Источниками»', () => {
    const { container } = render(<LandingContent landing={landingBySlug('dolina-gejzerov-kak-popast')} tours={[]} showH1={false} kuzmich />);
    const toc = [...container.querySelectorAll('nav a[href^="#"]')].map((a) => a.getAttribute('href')!.slice(1));
    expect(toc.length).toBeGreaterThanOrEqual(3);
    for (const id of toc) expect(container.querySelector(`[id="${id}"]`), id).toBeTruthy();
    const k = container.querySelector('a[href="https://t.me/kuzmichai_bot"]');
    expect(k).toBeTruthy();
    expect(container.innerHTML.indexOf('landing-kuzmich')).toBeLessThan(container.innerHTML.lastIndexOf('Источники'));
  });

  it('фото в тексте — lazy с размерами; цветной блок размечен явно', () => {
    const { container } = render(<LandingContent landing={landingBySlug('medvedi-kamchatki')} tours={[]} showH1={false} />);
    const img = container.querySelector('figure img')!;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('width')).toBeTruthy();
    expect(img.getAttribute('height')).toBeTruthy();
    expect(container.querySelector('figcaption')?.textContent).toMatch(/Фото:/);
    expect(container.querySelector('[data-landing-callout="danger"]')).toBeTruthy();
  });

  it('карточка тура: просмотренная обложка с подписью оператора; чужая обложка — градиент', () => {
    const [slug, src] = Object.entries(REVIEWED_TOUR_COVERS)[0];
    const base = {
      base_price: '10000', price_unit: 'per_person', duration_hours: '8', operator_name: 'Лагуна Экспедиция',
      operator_slug: 'laguna-expedition', operator_public: true, season_start: null, season_end: null,
      next_open_date: null, any_day_open: null,
    } as unknown as LandingBlockTour;
    const l = LANDINGS.find((x) => x.tours.kind !== 'none' && landingDesign(x.slug).hero)!;
    const { container } = render(
      <LandingContent landing={l} showH1={false} tours={[
        { ...base, id: '1', slug, title: 'Тур А', cover: src },
        { ...base, id: '2', slug: 'drugoj', title: 'Тур Б', cover: '/api/images/s3/photos/x/y.jpg' },
      ]} />,
    );
    const cards = container.querySelectorAll('[data-landing-tour]');
    expect(cards[0].querySelector('img.landing-tour-cover')?.getAttribute('loading')).toBe('lazy');
    expect(cards[0].querySelector('img.landing-tour-cover')?.getAttribute('fetchpriority')).toBeNull();
    expect(cards[0].textContent).toMatch(/Фото: Лагуна Экспедиция/);
    expect(cards[1].querySelector('img')).toBeNull();
    expect(cards[1].querySelector('.landing-tour-cover--plain')).toBeTruthy();
  });

  it('без героя первая обложка — eager, вторая остаётся lazy', () => {
    const [slug, src] = Object.entries(REVIEWED_TOUR_COVERS)[0];
    const base = {
      base_price: '10000', price_unit: 'per_person', duration_hours: '8', operator_name: 'Лагуна Экспедиция',
      operator_slug: 'laguna-expedition', operator_public: true, season_start: null, season_end: null,
      next_open_date: null, any_day_open: null,
    } as unknown as LandingBlockTour;
    const l = landingBySlug('chto-vzyat-s-soboj-na-kamchatku');
    expect(landingDesign(l.slug).hero).toBeNull();
    const { container } = render(
      <LandingContent landing={l} showH1={false} tours={[
        { ...base, id: '1', slug, title: 'Тур А', cover: src },
        { ...base, id: '2', slug, title: 'Тур Б', cover: src },
      ]} />,
    );
    const covers = [...container.querySelectorAll('img.landing-tour-cover')];
    expect(covers).toHaveLength(2);
    expect(covers[0].getAttribute('loading')).toBeNull();
    expect(covers[0].getAttribute('fetchpriority')).toBe('high');
    expect(covers[1].getAttribute('loading')).toBe('lazy');
    expect(covers[1].getAttribute('fetchpriority')).toBeNull();
  });
});

describe('герой и og:image', () => {
  it('герой — priority, размеры, подпись автора; og:image и Article.image = герой', () => {
    const withHero = LANDINGS.filter((l) => landingDesign(l.slug).hero);
    expect(withHero.length).toBeGreaterThan(20);
    for (const l of withHero) {
      const d = landingDesign(l.slug);
      const hero = d.hero!;
      const heroOg = landingOgImagePath(hero);
      const meta = landingPageMetadata(l);
      const ogImages = (meta.openGraph?.images ?? []) as Array<{ url: string; width?: number; height?: number; alt?: string }>;
      if (d.og) {
        expect(ogImages[0]?.url, l.slug).toBe(`https://vedarai.ru${d.og.src}`);
        expect(ogImages[0]?.width, l.slug).toBe(1200);
        expect(ogImages[0]?.height, l.slug).toBe(630);
      } else {
        expect(ogImages[0]?.url, l.slug).toBe(`https://vedarai.ru${heroOg}`);
      }
      expect(JSON.stringify(landingJsonLd(l)), l.slug).toContain(heroOg);
    }
    const l = withHero[0];
    const { container } = render(<LandingHero h1={l.h1} photo={landingDesign(l.slug).hero} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.getAttribute('loading')).not.toBe('lazy');
    expect(img.getAttribute('width')).toBeTruthy();
    expect(container.querySelector('h1')?.textContent).toBe(l.h1);
    expect(container.querySelector('figcaption')?.textContent).toMatch(/Фото:/);
  });

  it('без точного кадра — градиент, h1 на месте, без <img>', () => {
    const l = LANDINGS.find((x) => !landingDesign(x.slug).hero)!;
    const { container } = render(<LandingHero h1={l.h1} photo={null} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe(l.h1);
  });

  const OWN_OG = [
    'kamchatka-v-oktyabre', 'kamchatka-samostoyatelno', 'kamchatka-s-detmi',
    'chto-privezti-s-kamchatki', 'gornolyzhnye-bazy-kamchatki', 'kamchatskaya-kukhnya-gde-poest',
    'putevka-na-rybalku-gosuslugi41', 'chto-vzyat-s-soboj-na-kamchatku', 'svyaz-i-internet-na-kamchatke',
    'komandorskie-ostrova-kak-popast', 'splav-na-kamchatke', 'raznica-vo-vremeni-kamchatka-moskva',
    'kogda-ehat-na-kamchatku', 'voshozhdeniya-na-vulkany-kamchatki', 'sobachi-upryazhki-kamchatka',
    'gonka-beringiya', 'nalychevo-kak-dobratsya', 'avachinskij-pereval-i-verblyud',
    'gde-ostanovitsya-na-kamchatke', 'tolbachik-samostoyatelno', 'dolina-gejzerov-kak-popast',
  ];

  it('свой og:image — абсолютный https, 1200×630, alt, twitter:card summary_large_image, не общая картинка сайта', () => {
    for (const slug of OWN_OG) {
      const d = landingDesign(slug);
      expect(d.og, slug).toBeTruthy();
      expect(d.og!.src, slug).toBe(`/images/og/landings/${slug}.jpg`);
      expect(d.og!.width, slug).toBe(1200);
      expect(d.og!.height, slug).toBe(630);
      expect(d.og!.alt.length, slug).toBeGreaterThan(5);
      const file = join(process.cwd(), 'public', 'images', 'og', 'landings', `${slug}.jpg`);
      expect(existsSync(file), file).toBe(true);
      const l = landingBySlug(slug);
      const meta = landingPageMetadata(l);
      const images = (meta.openGraph?.images ?? []) as Array<{ url: string; width?: number; height?: number; alt?: string }>;
      expect(images[0]?.url, slug).toBe(`https://vedarai.ru/images/og/landings/${slug}.jpg`);
      expect(images[0]?.width, slug).toBe(1200);
      expect(images[0]?.height, slug).toBe(630);
      expect((images[0]?.alt ?? '').length, slug).toBeGreaterThan(5);
      expect(images[0]?.url, slug).not.toMatch(/vedar-1200x630/);
      expect(meta.twitter?.card, slug).toBe('summary_large_image');
    }
  });

  it('герои Толбачика и Долины гейзеров — исходник не меньше 1280 px по ширине', () => {
    expect(landingDesign('tolbachik-samostoyatelno').hero!.width).toBeGreaterThanOrEqual(1280);
    expect(landingDesign('tolbachik-samostoyatelno').hero!.src).toContain('tolbachik-dead-forest');
    expect(landingDesign('dolina-gejzerov-kak-popast').hero!.width).toBeGreaterThanOrEqual(1280);
    expect(landingDesign('dolina-gejzerov-kak-popast').hero!.src).toContain('kronotsky/dolina-gejzerov');
  });
});
