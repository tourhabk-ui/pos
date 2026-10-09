/**
 * Сторож: ролики живут в хранилище (S3), а не в репозитории — владелец
 * 09.10: «видео тоже в s3».
 *
 * Держит связку целиком (§10.09): у манифеста есть производитель (заливка с
 * раннера по маркеру) и потребитель (адрес ролика на странице); каждый путь
 * `/video/...`, записанный миграциями в базу, есть в манифесте, — иначе
 * страница сослалась бы на объект, которого заливка не знает.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { VIDEO_FILES } from '@/lib/media/video-manifest';
import { mediaProblems } from '@/lib/media/video-hygiene';

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

  it('файлы в репозитории сходятся с манифестом и годятся в хранилище', () => {
    for (const [p, f] of Object.entries(VIDEO_FILES)) {
      const file = join(ROOT, 'public', p);
      expect(existsSync(file), p).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.length, p).toBe(f.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), p).toBe(f.sha256);
      expect(mediaProblems(bytes, f.type), p).toEqual([]);
    }
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
