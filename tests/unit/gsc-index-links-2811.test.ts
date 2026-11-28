/**
 * Битые ссылки из разбора индексации Search Console (28.11).
 *
 * На китайских путеводителях /zh/kamchatka-zimoj и /zh/safety три ссылки
 * вели на 404: /paratunka (относительная и абсолютная) и
 * /dolina-gejzerov-kak-popast. Таких страниц на сайте не было, поэтому
 * правится ссылка, а не ставится переадресация: Паратунка —
 * /places/paratunskaya-zona-otdyha, Долина гейзеров — /dolina-gejzerov-ekskursiya.
 *
 * Сторож судит данные путеводителей: все href из разделов, живого блока,
 * «смотрите также» и источников.
 */
import { describe, it, expect } from 'vitest';
import { ZH_WINTER_GUIDE, ZH_SAFETY_GUIDE, type ZhGuide } from '@/lib/zh/guides';

const hrefs = (g: ZhGuide): string[] => [
  ...g.sections.flatMap((s) => (s.links ?? []).map((l) => l.href)),
  g.live?.href,
  ...g.related.map((l) => l.href),
  ...g.sources.map((s) => s.href),
].filter((h): h is string => typeof h === 'string');

const ALL = [...hrefs(ZH_WINTER_GUIDE), ...hrefs(ZH_SAFETY_GUIDE)];

describe('китайские путеводители: ссылки не ведут на 404', () => {
  it('нет /paratunka ни относительной, ни абсолютной ссылкой', () => {
    expect(ALL.filter((h) => /(^|vedarai\.ru)\/paratunka(?=$|[/?#])/.test(h))).toEqual([]);
  });

  it('нет /dolina-gejzerov-kak-popast', () => {
    expect(ALL.filter((h) => /\/dolina-gejzerov-kak-popast(?=$|[/?#])/.test(h))).toEqual([]);
  });

  it('Паратунка — карточкой места, оба вида ссылки; Долина гейзеров — страницей экскурсии', () => {
    expect(hrefs(ZH_WINTER_GUIDE)).toContain('/places/paratunskaya-zona-otdyha');
    expect(hrefs(ZH_WINTER_GUIDE)).toContain('https://vedarai.ru/places/paratunskaya-zona-otdyha');
    expect(hrefs(ZH_SAFETY_GUIDE)).toContain('/dolina-gejzerov-ekskursiya');
  });
});
