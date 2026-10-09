/**
 * Сторож: ролики живут в хранилище (S3), а не в репозитории — владелец
 * 09.10: «видео тоже в s3».
 *
 * Держит связку целиком (§10.09): у манифеста есть производитель (заливка с
 * раннера по маркеру) и потребитель (адрес ролика на странице); каждый путь
 * `/video/...`, записанный миграциями в базу, есть в манифесте, — иначе
 * страница сослалась бы на объект, которого заливка не знает.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { VIDEO_FILES } from '@/lib/media/video-manifest';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const PATHS = Object.keys(VIDEO_FILES);

describe('манифест роликов', () => {
  it('каждый путь — в форме, которую принимает база (CHECK partners_video_shape)', () => {
    const check = read('migrations/1185_shatun_charter_carrier.sql');
    expect(check).toMatch(/\^\/video\/\[a-z0-9\/\._-\]\+\\\.\(mp4\|webm\)\$/);
    for (const p of PATHS) {
      expect(p, p).toMatch(/^\/video\/[a-z0-9/._-]+\.(mp4|webm|jpg|webp)$/);
      expect(VIDEO_FILES[p]!.type, p).toBe(p.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
      expect(VIDEO_FILES[p]!.sha256, p).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('у каждого ролика есть обложка: база без неё ролик не примет', () => {
    for (const p of PATHS.filter((x) => x.endsWith('.mp4'))) {
      expect(PATHS, p).toContain(p.replace(/\.mp4$/, '.poster.jpg'));
    }
  });

  it('каждый путь /video/, записанный миграциями, есть в манифесте', () => {
    const dir = join(ROOT, 'migrations');
    const used = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/'(\/video\/[a-z0-9/._-]+\.(?:mp4|webm|jpg|webp))'/g)) {
        used.add(m[1]!);
      }
    }
    expect(used.size, 'миграции не пишут ни одного ролика — сторожу нечего сверять').toBeGreaterThan(0);
    expect([...used].filter((p) => !(p in VIDEO_FILES))).toEqual([]);
  });

  it('в репозитории роликов нет: они в хранилище', () => {
    // Байты сверяет заливка (video-to-s3.yml): здесь их больше нет и не должно быть.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    expect(existsSync(join(ROOT, 'public/video'))).toBe(false);
    expect(walk(join(ROOT, 'public')).filter((f) => /\.(mp4|webm|mov|m4v)$/i.test(f))).toEqual([]);
  });
});

describe('заливка: маркер → workflow → скрипт → хранилище', () => {
  const wf = read('.github/workflows/video-to-s3.yml');

  it('workflow запускается пушем маркера и просит только чтение репозитория', () => {
    expect(wf).toMatch(/paths:\n\s+- '\.github\/triggers\/video-to-s3\.json'/);
    expect(wf).toMatch(/branches: \[main, 'claude\/\*\*', 'ccr-\*'\]/);
    expect(wf).toMatch(/^permissions:\n  contents: read$/m);
    for (const s of ['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_ENDPOINT']) {
      expect(wf, s).toContain(`${s}: \${{ secrets.${s} }}`);
    }
    expect(wf).toMatch(/npx tsx scripts\/media\/upload-videos\.ts \$FLAG/);
    expect(wf).toMatch(/set -euo pipefail/);
  });

  it('итог читается через API: check-run, и имя бакета в нём вычеркнуто', () => {
    expect(wf).toMatch(/checks: write/);
    expect(wf).toMatch(/'name': 'video-to-s3'/);
    expect(wf).toMatch(/text = text\.replace\(bucket, '\*\*\*'\)/);
  });

  it('маркер существует и разбирается', () => {
    const marker = JSON.parse(read('.github/triggers/video-to-s3.json')) as { upload?: unknown; note?: unknown };
    expect(typeof marker.upload).toBe('boolean');
    expect(String(marker.note)).toMatch(/video-to-s3\.yml/);
  });

  it('скрипт заливает через syncVideos и красит прогон по её итогу', () => {
    const src = read('scripts/media/upload-videos.ts');
    expect(src).toMatch(/syncVideos\(io, \{ upload \}\)/);
    expect(src).toMatch(/uploadToS3\(key, body, type\)/);
    expect(src).toMatch(/syncSucceeded\(outcomes\) \? 0 : 1/);
  });
});

// ── Отдача: страница — прямой адрес хранилища, старый путь — переадресация ──

const BEARS = '/video/shatun/shatun-bears.mp4';
const BASE = 'https://s3.twcstorage.ru/vedar-test';

async function withBucket<T>(bucket: string, load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  vi.stubEnv('S3_ENDPOINT', 'https://s3.twcstorage.ru');
  vi.stubEnv('S3_BUCKET', bucket);
  return load();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@/lib/database');
  vi.restoreAllMocks();
});

describe('/video/[...path]: старый путь ведёт в хранилище', () => {
  type Route = typeof import('@/app/video/[...path]/route');
  const call = (r: Route, path: string[]) =>
    r.GET({} as NextRequest, { params: Promise.resolve({ path }) });

  it('путь из манифеста — 302 на объект в хранилище', async () => {
    const r = await withBucket('vedar-test', () => import('@/app/video/[...path]/route'));
    const res = await call(r, ['shatun', 'shatun-bears.mp4']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}${BEARS}`);
    const poster = await call(r, ['shatun', 'shatun-bears.poster.jpg']);
    expect(poster.headers.get('location')).toBe(`${BASE}/video/shatun/shatun-bears.poster.jpg`);
  });

  it('пути вне манифеста — 404: адрес хранилища из ввода не строится', async () => {
    const r = await withBucket('vedar-test', () => import('@/app/video/[...path]/route'));
    for (const path of [['shatun', 'evil.mp4'], ['..', 'etc', 'passwd'], ['shatun', 'shatun-bears.mp4', 'x']]) {
      const res = await call(r, path);
      expect(res.status, path.join('/')).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('хранилище не настроено — 503 и строка в лог, а не переадресация в никуда', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await withBucket('', () => import('@/app/video/[...path]/route'));
    const res = await call(r, ['shatun', 'shatun-bears.mp4']);
    expect(res.status).toBe(503);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[video]'), { path: BEARS });
  });
});

describe('страница получает адрес объекта, а не круг через переадресацию', () => {
  const ROW = {
    id: 'p1', slug: 'shatun', name: 'Шатун', short_description: null, hero_image: null, gallery: null,
    video_url: BEARS, video_poster_url: '/video/shatun/shatun-bears.poster.jpg', gallery_credits: {},
    video_clips: [{ url: '/video/shatun/clip-water-approach.mp4', poster: '/video/shatun/clip-water-approach.poster.jpg', label: 'Подход' }],
    company_name: null, legal_info: null, contacts: null,
  };
  const loader = () => {
    vi.doMock('@/lib/database', () => ({
      query: async (sql: string) => ({ rows: sql.includes('FROM partners p') ? [ROW] : [] }),
    }));
    return import('@/lib/transfers/charter');
  };

  it('ролик, обложка и клипы перевозчика — адреса в хранилище', async () => {
    const { loadCharterCarriers } = await withBucket('vedar-test', loader);
    const [c] = await loadCharterCarriers();
    expect(c!.video).toEqual({ url: `${BASE}${BEARS}`, poster: `${BASE}/video/shatun/shatun-bears.poster.jpg` });
    expect(c!.clips).toEqual([{
      url: `${BASE}/video/shatun/clip-water-approach.mp4`,
      poster: `${BASE}/video/shatun/clip-water-approach.poster.jpg`,
      label: 'Подход',
    }]);
  });

  it('без хранилища — путь как есть: его разберёт /video/[...path]', async () => {
    const { loadCharterCarriers } = await withBucket('', loader);
    const [c] = await loadCharterCarriers();
    expect(c!.video?.url).toBe(BEARS);
  });

  it('CSP пускает видео с хоста хранилища: без media-src ролик не играет', () => {
    const cfg = read('next.config.js');
    const main = cfg.slice(cfg.indexOf("source: '/:path((?!widget/).*)'"));
    const csp = /Content-Security-Policy', value: `([^`]+)`/.exec(main)![1]!;
    expect(csp).toMatch(/media-src 'self' https:\/\/s3\.twcstorage\.ru;/);
    // Хост тот же, из которого строится адрес объекта по умолчанию.
    expect(read('lib/storage/s3.ts')).toMatch(/S3_ENDPOINT\s+= process\.env\.S3_ENDPOINT \|\| 'https:\/\/s3\.twcstorage\.ru'/);
  });
});
