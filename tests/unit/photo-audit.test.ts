/**
 * Сторож аудита снимков мест (владелец 03.10: один кадр у двух источников,
 * водяной знак фотостока; «нужен инструмент сравнения фото с местом»).
 *
 * Держит: отпечаток детерминирован и переживает пережатие; дубль ищется между
 * РАЗНЫМИ местами; разбор ответа модели даёт три исхода и не выдумывает
 * «нет» из молчания; промпт не просит узнать конкретное место; роут пишет
 * только свои колонки и не трогает показ; задачи заведены в актуаторе и реестрах.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import {
  dHash, hamming, duplicatePairs, parseVisionVerdict, visionAuditPrompt, needsHumanEye, DUPLICATE_MAX_DISTANCE,
} from '@/lib/images/photo-audit';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

async function picture(seed: number, w = 320, h = 240): Promise<Buffer> {
  // Градиент с «горизонтом» на высоте seed: разные seed — разные кадры.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <rect y="${seed}" width="${w}" height="${Math.round(h / 4)}" fill="#808080"/>
    <circle cx="${(seed * 7) % w}" cy="${(seed * 3) % h}" r="${20 + (seed % 30)}" fill="#fff"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

describe('отпечаток восприятия', () => {
  it('детерминирован и переживает пережатие и уменьшение', async () => {
    const a = await picture(40);
    const h1 = await dHash(a);
    const h2 = await dHash(a);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).toBe(h2);
    const small = await sharp(a).resize(160, 120).jpeg({ quality: 50 }).toBuffer();
    expect(hamming(h1, await dHash(small))).toBeLessThanOrEqual(DUPLICATE_MAX_DISTANCE);
  });

  it('разные кадры далеки друг от друга', async () => {
    const h1 = await dHash(await picture(10));
    const h2 = await dHash(await picture(170));
    expect(hamming(h1, h2)).toBeGreaterThan(DUPLICATE_MAX_DISTANCE);
  });

  it('битый отпечаток — максимальное расстояние, не ноль', () => {
    expect(hamming('zz', '0000000000000000')).toBe(64);
    expect(hamming('0000000000000000', '0000000000000000')).toBe(0);
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('дубли — пары РАЗНЫХ мест; одно место с собой не пара', () => {
    const rows = [
      { arkId: 'a', place: 'Ходуткинские', phash: '0f0f0f0f0f0f0f0f' },
      { arkId: 'b', place: 'Нижне-Вилючинские', phash: '0f0f0f0f0f0f0f0e' },
      { arkId: 'a', place: 'Ходуткинские', phash: '0f0f0f0f0f0f0f0f' },
      { arkId: 'c', place: 'Асачинские', phash: 'f0f0f0f0f0f0f0f0' },
    ];
    const pairs = duplicatePairs(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.place).toBe('Ходуткинские');
    expect(pairs[0].b.place).toBe('Нижне-Вилючинские');
    expect(pairs[0].distance).toBe(1);
  });
});

describe('зрение: три исхода и без выдумки', () => {
  const legs = [{ provider: 'qwen_vl', model: 'qwen3-vl-plus', outcome: 'ok' as const, detail: null, ms: 1 }];

  it('разбирает JSON, обрезанный пояснениями', () => {
    const v = parseVisionVerdict({ text: 'Вот ответ: {"depicts":"люди в бассейне","watermark":"yes","matches_type":"yes"} готово', legs });
    expect(v).toMatchObject({ depicts: 'люди в бассейне', watermark: 'yes', matchesType: 'yes', model: 'qwen3-vl-plus' });
  });

  it('не JSON, пустой ответ, чужие значения — unknown, сырой текст сохраняется', () => {
    expect(parseVisionVerdict({ text: 'не знаю', legs })).toMatchObject({ watermark: 'unknown', matchesType: 'unknown', raw: 'не знаю' });
    expect(parseVisionVerdict({ text: null, legs: [] })).toMatchObject({ watermark: 'unknown', matchesType: 'unknown', provider: null });
    expect(parseVisionVerdict({ text: '{"watermark":"maybe","matches_type":1}', legs })).toMatchObject({ watermark: 'unknown', matchesType: 'unknown' });
  });

  it('промпт просит видимое, велит не угадывать и не узнавать место', () => {
    const p = visionAuditPrompt('Ходуткинские горячие источники', 'термальный источник');
    expect(p).toContain('"unknown"');
    expect(p).toContain('не угадывай');
    expect(p).toContain('Конкретное место по снимку не определяй');
    expect(p).toMatch(/alamy/);
  });

  it('взгляд человека нужен при водяном знаке, не том роде или дубле; unknown сам по себе — нет', () => {
    expect(needsHumanEye({ watermark: 'yes', matchesType: 'yes' }, false)).toBe(true);
    expect(needsHumanEye({ watermark: 'no', matchesType: 'no' }, false)).toBe(true);
    expect(needsHumanEye({ watermark: 'unknown', matchesType: 'unknown' }, false)).toBe(false);
    expect(needsHumanEye(null, true)).toBe(true);
    expect(needsHumanEye({ watermark: 'no', matchesType: 'yes' }, false)).toBe(false);
  });
});

describe('роут и реестры', () => {
  const route = read('app/api/cron/photo-audit/route.ts');

  it('GET только читает; POST пишет только свои колонки и не трогает показ', () => {
    const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
    expect(get).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    const updates = route.match(/UPDATE ai_route_images SET [^`]+/g) ?? [];
    expect(updates.length).toBe(2);
    for (const u of updates) {
      expect(u).toMatch(/SET (phash|vision_verdict)/);
      expect(u).not.toMatch(/model|image_data|s3_url|author|license|thumb_url/);
      // Пишется только в пустое: повторная партия не перетирает уже посчитанное.
      expect(u).toMatch(/IS NULL/);
    }
    expect(route).toContain("z.enum(['phash', 'vision'])");
    expect(route).toContain('dry_run: z.boolean().default(true)');
    expect(route).toContain("z.string().min(10");
    expect(route).toContain('shownPhotoSql(');
    expect(route).toContain('is_visible IS NOT FALSE AND p.merged_into_id IS NULL');
  });

  it('молчание зрения — отказ партии, вердикт не пишется', () => {
    expect(route).toMatch(/if \(!result\.text\) \{[\s\S]*?failed\.push[\s\S]*?continue;/);
  });

  it('миграция 1146 заводит колонки; актуатор знает задачи; реестр возможностей честен', () => {
    const m = read('migrations/1146_photo_audit.sql');
    for (const c of ['phash', 'phash_at', 'vision_verdict', 'vision_at']) expect(m).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\s`));
    const wf = read('.github/workflows/images-repack.yml');
    expect(wf).toContain("'phash', 'vision'");
    expect(wf).toContain('PATH_="/api/cron/photo-audit"');
    expect(wf).toContain("a.get('audited_count', 0)");
    expect(CRON_CAPABILITIES['photo-audit']).toEqual(['db_read', 'db_write', 'net_out', 'ai']);
  });
});
