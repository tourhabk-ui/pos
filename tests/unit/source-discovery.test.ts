/**
 * tests/unit/source-discovery.test.ts
 *
 * Подбор источников: модель предлагает, приговор выносит сервер.
 *
 * Адрес — тот вид факта, который модель выдумывает охотнее всего:
 * `https://<ведомство>.gov.ru/rss` выглядит правдоподобно ВСЕГДА. В этом
 * репозитории уже записано, чем кончается доверие к правдоподобному: у МЧС и
 * kamgov ленты сняты (404), и «гадать новый URL нечего» стоит прямым текстом.
 *
 * Поэтому сторож держит два свойства:
 *   — отбраковка решает по ФОРМЕ, а не по убедительности объяснения;
 *   — отказ адреса С РАННЕРА не выдаётся за «ленты нет»: раннер стоит вне РФ,
 *     и часть государственных сайтов закрывает зарубежные адреса. Это зеркало
 *     нашей же беды с t.me, закрытым с прода.
 */
import { describe, it, expect } from 'vitest';
import { filterCandidates, judgeCensus } from '../../scripts/source-discovery-runner';

const ok = (over: Record<string, unknown> = {}) => ({
  name: 'Тест', url: 'https://example.org/feed.xml', kind: 'rss', area: 'law',
  why: 'зачем-то', confidence: 'known', ...over,
});

describe('отбраковка кандидатов: решает форма, а не убедительность', () => {
  it('годный кандидат проходит', () => {
    const r = filterCandidates({ candidates: [ok()] });
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it('выдуманный «адрес» без адреса не проходит', () => {
    const r = filterCandidates({ candidates: [{ name: 'Ведомство', kind: 'rss', area: 'law' }] });
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].why).toMatch(/адреса нет/);
  });

  it('не-https отбрасывается', () => {
    const r = filterCandidates({ candidates: [ok({ url: 'http://example.org/feed.xml' })] });
    expect(r.kept).toHaveLength(0);
  });

  it('вид источника, который мы не умеем читать, отбрасывается', () => {
    // HTML-страница с разбором вёрстки — это скрейпер, а мы их только что вычистили.
    const r = filterCandidates({ candidates: [ok({ kind: 'html' })] });
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].why).toMatch(/читать не умеем/);
  });

  it('ссылка-приглашение Telegram отбрасывается: закрытый чат читать нельзя', () => {
    const r = filterCandidates({
      candidates: [ok({ kind: 'telegram', url: 'https://t.me/+ll3pbl442dNkZmYy' })],
    });
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].why).toMatch(/t\.me\/s/);
  });

  it('публичное превью Telegram проходит', () => {
    const r = filterCandidates({
      candidates: [ok({ kind: 'telegram', url: 'https://t.me/s/kbgsras', area: 'hazard' })],
    });
    expect(r.kept).toHaveLength(1);
  });

  it('уже стоящий в разведке источник не предлагается заново', () => {
    const r = filterCandidates({ candidates: [ok({ url: 'https://t.me/s/ru_rst', kind: 'telegram' })] });
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].why).toMatch(/уже стоит/);
  });

  it('повтор внутри одного ответа считается один раз', () => {
    const r = filterCandidates({ candidates: [ok(), ok({ url: 'https://EXAMPLE.org/feed.xml/' })] });
    expect(r.kept).toHaveLength(1);
    expect(r.dropped[0].why).toMatch(/повтор/);
  });

  it('область, которую не спрашивали, отбрасывается', () => {
    const r = filterCandidates({ candidates: [ok({ area: 'ai' })] });
    expect(r.kept).toHaveLength(0);
  });

  it('ответ не той формы — пусто, а не падение', () => {
    expect(filterCandidates({}).kept).toEqual([]);
    expect(filterCandidates(null).kept).toEqual([]);
    expect(filterCandidates({ candidates: 'нет' }).kept).toEqual([]);
    expect(filterCandidates({ candidates: [null] }).kept).toEqual([]);
  });
});

describe('приговор переписи: три разных «нет»', () => {
  it('живая лента', () => {
    expect(judgeCensus(200, 'application/rss+xml', 5000)).toBe('feed_ok');
    expect(judgeCensus(200, 'text/xml; charset=utf-8', 900)).toBe('feed_ok');
  });

  it('снятая лента — dead', () => {
    expect(judgeCensus(404, 'text/html', 500)).toBe('dead');
    expect(judgeCensus(410, 'text/html', 500)).toBe('dead');
  });

  it('закрыто ДЛЯ НАС — refused_here, и это не «ленты нет»', () => {
    // Ключевое различение. Раннер вне РФ; похоронить живой источник по
    // признаку нашего местоположения — та же ошибка, что и наоборот с t.me.
    expect(judgeCensus(403, 'text/html', 100)).toBe('refused_here');
    expect(judgeCensus(451, 'text/html', 100)).toBe('refused_here');
  });

  it('страница вместо ленты — not_a_feed', () => {
    expect(judgeCensus(200, 'text/html; charset=utf-8', 40_000)).toBe('not_a_feed');
  });

  it('пустой XML лентой не считается: 200 сам по себе ничего не обещает', () => {
    expect(judgeCensus(200, 'application/xml', 50)).toBe('not_a_feed');
  });

  it('сеть не ответила — unreachable, отдельно от всего прочего', () => {
    expect(judgeCensus(null, '', 0)).toBe('unreachable');
    expect(judgeCensus(500, 'text/html', 0)).toBe('unreachable');
  });
});
