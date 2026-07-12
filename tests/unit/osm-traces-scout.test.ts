/**
 * OSM Traces Scout: разбор RSS-ленты /traces/rss и фильтр bbox Камчатки.
 * Сетевые/БД-части покрываются прод-запуском (workflow печатает диагностику).
 */

import { describe, it, expect } from 'vitest';
import { parseTracesRss, isInKamchatka } from '@/lib/services/osm-traces-scout';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:georss="http://www.georss.org/georss">
<channel>
<item>
  <title>avacha_2026-07-10.gpx</title>
  <link>https://www.openstreetmap.org/user/hiker/traces/11862279</link>
  <description>Подъём на Авачинский</description>
  <pubDate>Fri, 10 Jul 2026 08:12:00 +0000</pubDate>
  <georss:point>53.255 158.833</georss:point>
</item>
<item>
  <title><![CDATA[Munich ride]]></title>
  <link>https://www.openstreetmap.org/user/biker/traces/11862280</link>
  <pubDate>Fri, 10 Jul 2026 09:00:00 +0000</pubDate>
  <georss:point>48.137 11.575</georss:point>
</item>
<item>
  <title>без точки — пропускается</title>
  <link>https://www.openstreetmap.org/user/x/traces/11862281</link>
</item>
</channel>
</rss>`;

describe('parseTracesRss', () => {
  it('извлекает id, координату и заголовок; без georss:point — пропуск', () => {
    const items = parseTracesRss(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: '11862279',
      title: 'avacha_2026-07-10.gpx',
      lat: 53.255,
      lng: 158.833,
    });
    expect(items[0].link).toContain('/traces/11862279');
  });

  it('CDATA в заголовке разворачивается', () => {
    const items = parseTracesRss(RSS);
    expect(items[1].title).toBe('Munich ride');
  });

  it('пустая/невалидная лента — пустой список без падения', () => {
    expect(parseTracesRss('')).toEqual([]);
    expect(parseTracesRss('<html>503</html>')).toEqual([]);
  });
});

describe('isInKamchatka', () => {
  it('Авачинский вулкан — внутри', () => {
    expect(isInKamchatka(53.255, 158.833)).toBe(true);
  });
  it('Мюнхен и Владивосток — снаружи', () => {
    expect(isInKamchatka(48.137, 11.575)).toBe(false);
    expect(isInKamchatka(43.115, 131.885)).toBe(false);
  });
  it('север края (Палана) — внутри', () => {
    expect(isInKamchatka(59.084, 159.966)).toBe(true);
  });
});
