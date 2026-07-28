/**
 * kamgov приходит с раннера, а не с сервера.
 *
 * Каждый прогон safety-ingest заканчивался строкой
 *   "errors":["news feed unavailable: kamgov"]
 * — и так неделями. Фид при этом живой: с Timeweb не открывается kamgov.ru,
 * то есть ровно тот же случай, что t.me и КБГС РАН, для которых HTML давно
 * тянет GitHub-раннер и передаёт в теле POST.
 *
 * Цена молчания здесь не абстрактная: через kamgov приходят дорожные
 * ограничения и оперативные сводки Минтура о доступности туробъектов — то,
 * из-за чего турист разворачивается перед шлагбаумом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PARSER = read('lib/services/safety/seismic-parser.ts');
const ROUTE = read('app/api/cron/safety-ingest/route.ts');
const WORKFLOW = read('.github/workflows/cron-safety-ingest.yml');

describe('сервер принимает готовый XML', () => {
  it('разбор фида отделён от его скачивания', () => {
    expect(PARSER).toContain('export async function ingestNewsFeedXmls');
    // Классификация та же, что у остальных источников: дорожные ограничения и
    // вулканические бюллетени из kamgov попадают в external_alerts наравне.
    const fn = PARSER.slice(PARSER.indexOf('export async function ingestNewsFeedXmls'));
    expect(fn).toContain('classifyMchsItem');
    expect(fn).toContain('saveEvent');
  });

  it('принесённый снаружи источник сервер не тянет и мёртвым не считает', () => {
    expect(PARSER).toContain('skipPrefixes: string[] = []');
    expect(PARSER).toContain('if (skipPrefixes.includes(source.prefix)) continue;');
    expect(ROUTE).toContain("ingestNewsFeeds(kamgovXmls.length > 0 ? ['kamgov'] : [])");
  });

  it('в ответе крона новости остаются одним блоком', () => {
    // Дробить `news` на «серверные» и «раннерные» было бы честно к коду и
    // непонятно человеку.
    expect(ROUTE).toContain('mergeParseResults(newsFeedResult, kamgovResult)');
  });

  it('схема принимает массив фидов и ограничивает размер', () => {
    expect(ROUTE).toContain('kamgov_xml: z.array(z.string().max(600_000)).max(5).optional()');
  });
});

describe('раннер приносит фид', () => {
  it('тянет все известные пути kamgov', () => {
    for (const u of [
      'https://www.kamgov.ru/rss',
      'https://www.kamgov.ru/mintur/rss',
      'https://www.kamgov.ru/mintur/news/rss',
    ]) {
      expect(WORKFLOW).toContain(u);
    }
  });

  it('не-RSS отбрасывается: гос-сайт на битый путь отдаёт HTML', () => {
    expect(WORKFLOW).toContain('grep -qi "<rss\\|<feed"');
  });

  it('фид уезжает в теле запроса', () => {
    expect(WORKFLOW).toContain('--slurpfile kamgov_xml /tmp/kamgov_xml.json');
    expect(WORKFLOW).toContain('{kamgov_xml: $kamgov_xml[0]}');
  });

  it('пустой результат не ломает запрос', () => {
    // Недоступность источника не должна валить весь ingest: сейсмика и МЧС
    // важнее новостей и едут тем же запросом.
    expect(WORKFLOW).toContain('[ -s /tmp/kamgov_xml.json ] || echo "[]" > /tmp/kamgov_xml.json');
  });
});
