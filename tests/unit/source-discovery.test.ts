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
import {
  filterCandidates, judgeCensus, ageVerdict, lastTelegramPost, latestFeedDate,
  SOURCE_ALIVE_WINDOW_DAYS,
} from '../../scripts/source-discovery-runner';

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

  it('http поднимается до https и идёт в перепись, а не отбрасывается', () => {
    // Правило изменено 08.09 по прогону 3: восемь кандидатов из 25 ушли ровно
    // за схему, и среди них были настоящие — kamchatinfo.com (камчатское
    // агентство) и emsd.ru (Камчатский филиал Геофизической службы). Почти
    // любой живой сайт отвечает по https на том же адресе, и решать за сервер
    // по схеме значит терять годных по формальности.
    //
    // Строгости мы не потеряли: поднятый адрес получает тот же приговор от
    // сервера. Нет там https — это скажет запрос, а не наш фильтр.
    const r = filterCandidates({ candidates: [ok({ url: 'http://example.org/feed.xml' })] });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].url).toBe('https://example.org/feed.xml');
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

const NOW = Date.parse('2026-09-07T21:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('приговор переписи: отвечающий сервер — ещё не живой источник', () => {
  it('лента со свежим материалом', () => {
    expect(judgeCensus(200, 'application/rss+xml', 5000, daysAgo(1), NOW)).toBe('feed_ok');
  });

  it('лента отвечает, но последний материал старый — feed_stale, не feed_ok', () => {
    // Тот самый пропуск: первая редакция звала это живым источником, потому
    // что смотрела на статус и размер, а не на дату.
    expect(judgeCensus(200, 'application/rss+xml', 5000, daysAgo(SOURCE_ALIVE_WINDOW_DAYS + 1), NOW)).toBe('feed_stale');
  });

  it('даты нет — feed_undated: «не знаю» не равно «живой»', () => {
    expect(judgeCensus(200, 'application/xml', 5000, null, NOW)).toBe('feed_undated');
  });

  it('снятая лента — dead', () => {
    expect(judgeCensus(404, 'text/html', 500, null, NOW)).toBe('dead');
    expect(judgeCensus(410, 'text/html', 500, null, NOW)).toBe('dead');
  });

  it('закрыто ДЛЯ НАС — refused_here, и это не «ленты нет»', () => {
    // Раннер вне РФ; похоронить живой источник по признаку нашего
    // местоположения — та же ошибка, что и наоборот с t.me, закрытым с прода.
    expect(judgeCensus(403, 'text/html', 100, null, NOW)).toBe('refused_here');
    expect(judgeCensus(451, 'text/html', 100, null, NOW)).toBe('refused_here');
  });

  it('страница вместо ленты — not_a_feed', () => {
    expect(judgeCensus(200, 'text/html; charset=utf-8', 40_000, daysAgo(1), NOW)).toBe('not_a_feed');
  });

  it('пустой XML лентой не считается даже со свежей датой', () => {
    expect(judgeCensus(200, 'application/xml', 50, daysAgo(1), NOW)).toBe('not_a_feed');
  });

  it('сеть не ответила — unreachable, отдельно от всего прочего', () => {
    expect(judgeCensus(null, '', 0, null, NOW)).toBe('unreachable');
    expect(judgeCensus(500, 'text/html', 0, null, NOW)).toBe('unreachable');
  });

  it('окно источника мягче окна материала: молчание бывает сезонным', () => {
    // Двухнедельная новость в выпуске — уже ложь; двухнедельное молчание
    // официального канала — норма. Разные пороги не случайность.
    expect(SOURCE_ALIVE_WINDOW_DAYS).toBeGreaterThan(14);
    expect(ageVerdict(daysAgo(20), NOW)).toBe('feed_ok');
  });
});

describe('дата последнего материала вынимается, а не додумывается', () => {
  it('превью Telegram: берётся САМЫЙ СВЕЖИЙ пост, а не первый попавшийся', () => {
    const html = `
      <div class="tgme_widget_message"><time datetime="2026-09-01T10:00:00+00:00"></time></div>
      <div class="tgme_widget_message"><time datetime="2026-09-06T18:30:00+00:00"></time></div>
      <div class="tgme_widget_message"><time datetime="2026-08-20T08:00:00+00:00"></time></div>`;
    expect(lastTelegramPost(html)).toBe('2026-09-06T18:30:00.000Z');
  });

  it('канал с сотнями постов, но молчащий год — НЕ живой', () => {
    // Ровно то, что упустила первая редакция: она считала посты. Триста
    // постов бывают и у канала, умершего в позапрошлом году.
    const html = Array.from({ length: 300 }, () =>
      '<div class="tgme_widget_message"><time datetime="2025-03-01T10:00:00+00:00"></time></div>').join('');
    expect(ageVerdict(lastTelegramPost(html), NOW)).toBe('feed_stale');
  });

  it('превью без дат — feed_undated, а не feed_ok', () => {
    expect(lastTelegramPost('<div class="tgme_widget_message">без времени</div>')).toBeNull();
    expect(ageVerdict(null, NOW)).toBe('feed_undated');
  });

  it('лента: RSS, Atom и RDF-формы дат читаются разом, берётся свежайшая', () => {
    const xml = `<rss><channel>
      <item><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate></item>
      <item><pubDate>Sat, 06 Sep 2026 12:00:00 GMT</pubDate></item>
      <entry><updated>2026-08-01T00:00:00Z</updated></entry>
      <item><dc:date>2026-07-01T00:00:00Z</dc:date></item>
    </channel></rss>`;
    expect(latestFeedDate(xml)).toBe('2026-09-06T12:00:00.000Z');
  });

  it('лента без дат — null, и это не сегодня', () => {
    expect(latestFeedDate('<rss><channel><item><title>без даты</title></item></channel></rss>')).toBeNull();
  });
});
