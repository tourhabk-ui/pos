// @vitest-environment node
/**
 * Перепись снимков в хранилище видит ОБЕ таблицы (13.10).
 *
 * До этого дня `images-in-s3` считала только героя (`ai_route_images`), а
 * остальные кадры места живут в `place_gallery_photos` (968). На вопрос
 * владельца «фото все на s3?» такая перепись отвечала «да» про половину
 * снимков — третий исход выдавался за первый (§4.0). Повод заняться — фаза 2
 * переезда снимков из миграций (#2429): миграция 1228 переводит по хэшу
 * байтов в основном галерею, и без счётчиков галереи проверить это на проде
 * было бы нечем.
 *
 * Проверяется поведение — вызов обработчика с подменённым пулом и сетью, —
 * а не текст исходника.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;
type Answer = (sql: string, params: unknown[]) => Row[];

const SECRET = 'test-cron-secret';

async function loadRoute(answer: Answer) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: answer(sql, params) };
  });
  vi.resetModules();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('S3_BUCKET', 'vedar-test');
  vi.stubEnv('S3_ENDPOINT', 'https://s3.twcstorage.ru');
  vi.doMock('@/lib/db-pool', () => ({ pool: { query } }));
  const mod = await import('@/app/api/cron/images-in-s3/route');
  return { GET: mod.GET, calls };
}

function request(qs: string) {
  return new NextRequest(`https://vedarai.ru/api/cron/images-in-s3?${qs}`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

/** Ответы базы по смыслу запроса: счётчики героя, счётчики галереи, раскладка по роду, выборка. */
function answers(opts: { sample?: Row[] } = {}): Answer {
  return (sql) => {
    if (/COUNT\(\*\) FILTER/.test(sql) && /FROM place_gallery_photos/.test(sql)) {
      return [{ in_s3: '102', in_db: '0', neither: '0', migration_keys: '100' }];
    }
    if (/COUNT\(\*\) FILTER/.test(sql) && /FROM ai_route_images/.test(sql)) {
      return [{ in_s3: '650', in_db: '3', neither: '1', migration_keys: '7' }];
    }
    if (/GROUP BY model/.test(sql)) return [{ model: 'wikimedia', n: '600' }];
    if (/ORDER BY random\(\)/.test(sql)) return opts.sample ?? [];
    return [];
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('@/lib/db-pool');
});

describe('перепись считает героя и галерею раздельно', () => {
  it('в ответе — счётчики обеих таблиц и число ключей из миграций у каждой', async () => {
    const { GET } = await loadRoute(answers());
    const res = await GET(request('part=summary'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Поля героя — на верхнем уровне, как читали их прежние прогоны.
    expect(body).toMatchObject({ ok: true, in_s3: 650, in_db: 3, neither: 1, migration_keys: 7 });
    expect(body.gallery).toEqual({ in_s3: 102, in_db: 0, neither: 0, migration_keys: 100 });
  });

  it('ключи из миграций считаются по собственному префиксу, параметром, а не склейкой', async () => {
    const { GET, calls } = await loadRoute(answers());
    await GET(request('part=summary'));
    const countQueries = calls.filter(c => /COUNT\(\*\) FILTER/.test(c.sql));
    expect(countQueries).toHaveLength(2);
    for (const c of countQueries) {
      expect(c.sql).toMatch(/s3_key LIKE \$1/);
      expect(c.params).toEqual(['migrations/photos/%']);
    }
  });
});

describe('доступность спрашивается у того, что отдаст карточка', () => {
  it('строка с одним ключом проверяется по адресу из ключа, строка с адресом — по адресу', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET, calls } = await loadRoute(answers({
      sample: [
        { s3_url: null, s3_key: 'migrations/photos/abc123.jpg', subject_name: 'Вачкажец · кадр 1' },
        { s3_url: 'https://s3.twcstorage.ru/vedar-test/places/x/hero.jpg', s3_key: 'places/x/hero.jpg', subject_name: 'Вачкажец' },
      ],
    }));
    const res = await GET(request('part=summary&check=2'));
    const body = await res.json();

    const asked = fetchMock.mock.calls.map(([url, init]) => [String(url), (init as { method?: string })?.method]);
    expect(asked).toContainEqual(['https://s3.twcstorage.ru/vedar-test/migrations/photos/abc123.jpg', 'HEAD']);
    expect(asked).toContainEqual(['https://s3.twcstorage.ru/vedar-test/places/x/hero.jpg', 'HEAD']);
    expect(body.reachability).toMatchObject({ asked: 2, by_outcome: { open: 2 }, all_open: true });

    // Выборка берёт обе таблицы и обе формы записи — случайно.
    const sample = calls.find(c => /ORDER BY random\(\)/.test(c.sql));
    expect(sample?.sql).toMatch(/FROM ai_route_images/);
    expect(sample?.sql).toMatch(/FROM place_gallery_photos/);
    expect(sample?.sql).toMatch(/UNION ALL/);
    expect(sample?.params).toEqual([2]);
  });

  it('чужой адрес не запрашивается и называется отдельным исходом', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await loadRoute(answers({
      sample: [{ s3_url: 'https://elsewhere.example/x.jpg', s3_key: 'x.jpg', subject_name: 'Чужое' }],
    }));
    const body = await (await GET(request('part=summary&check=1'))).json();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.reachability.by_outcome).toEqual({ foreign: 1 });
    expect(body.reachability.all_open).toBe(false);
  });
});
