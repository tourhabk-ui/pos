/**
 * kamgov с сервера не тянется никогда (17.09).
 *
 * kamgov.ru с Timeweb закрыт (гео) — это записано в seismic-parser дважды.
 * Но оба пути инжеста всё равно ходили туда: heartbeat-GET — каждые 5 минут
 * без исключений, POST — всякий раз, когда в теле нет kamgov_xml. А реле
 * Cloudflare (первичный путь t.me с 03.09) kamgov не забирает по замыслу и
 * шлёт 12 POST в час — каждый писал «news feed unavailable: kamgov» и держал
 * статус прогона partial. Проверка, которая не может пройти по построению,
 * — не проверка, а шум (проба 514: три такие ошибки в одном heartbeat).
 *
 * Живой путь — XML от раннера через ingestNewsFeedXmls; он не тронут.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PARSER = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf-8');

describe('оба вызывающих пропускают kamgov на сервере', () => {
  it('heartbeat-GET (ingestAll)', () => {
    const all = PARSER.slice(PARSER.indexOf('const [kbgsras, eqkam, usgs, mchs, news, vk] = await Promise.all'), PARSER.indexOf('total_inserted: kbgsras.inserted'));
    expect(all).toMatch(/ingestNewsFeeds\(\['kamgov'\]\)/);
  });

  it('POST — безусловно, а не «если раннер не принёс»', () => {
    expect(ROUTE).toMatch(/ingestNewsFeeds\(\['kamgov'\]\)/);
    expect(ROUTE).not.toMatch(/ingestNewsFeeds\(kamgovXmls\.length > 0/);
  });

  it('путь раннера остался', () => {
    expect(ROUTE).toMatch(/ingestNewsFeedXmls\(kamgovXmls, 'kamgov'\)/);
  });
});
