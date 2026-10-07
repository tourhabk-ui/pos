/**
 * Агент модерации снимков туристов (решение владельца 04.10): одобряет чистые,
 * отклоняет повторы, фотосток, недопустимое и «не тот род», сомнительное
 * оставляет человеку. «Не знаю» не равно «чисто».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideUserPhoto, parseUserPhotoVerdict } from '@/lib/images/user-photo-moderation';

const clean = { watermark: 'no', matchesType: 'yes', peopleCloseup: 'no', inappropriate: 'no' } as const;

describe('правило решения', () => {
  it('чистый снимок нужного рода — одобрен', () => {
    expect(decideUserPhoto(clean, null).decision).toBe('approved');
  });
  it('повтор, фотосток, недопустимое, не тот род — отклонены', () => {
    expect(decideUserPhoto(clean, 'снимок платформы').decision).toBe('rejected');
    expect(decideUserPhoto({ ...clean, watermark: 'yes' }, null).decision).toBe('rejected');
    expect(decideUserPhoto({ ...clean, inappropriate: 'yes' }, null).decision).toBe('rejected');
    expect(decideUserPhoto({ ...clean, matchesType: 'no' }, null).decision).toBe('rejected');
  });
  it('люди крупным планом и любое «не знаю» — человеку, не публикуются', () => {
    expect(decideUserPhoto({ ...clean, peopleCloseup: 'yes' }, null).decision).toBe('human');
    for (const k of ['watermark', 'matchesType', 'peopleCloseup', 'inappropriate'] as const) {
      expect(decideUserPhoto({ ...clean, [k]: 'unknown' }, null).decision, k).toBe('human');
    }
  });
  it('непрочитанный ответ модели — всё «не знаю», то есть человеку', () => {
    const v = parseUserPhotoVerdict({ text: 'не могу ответить', legs: [] });
    expect(v.watermark).toBe('unknown');
    expect(decideUserPhoto(v, null).decision).toBe('human');
  });
  it('разбор JSON модели', () => {
    const v = parseUserPhotoVerdict({
      text: '{"depicts":"сопка над бухтой","watermark":"no","matches_type":"yes","people_closeup":"no","inappropriate":"no"}',
      legs: [{ provider: 'qwen', model: 'qwen3-vl-plus', outcome: 'ok' }] as never,
    });
    expect(v).toMatchObject({ depicts: 'сопка над бухтой', watermark: 'no', matchesType: 'yes', peopleCloseup: 'no', inappropriate: 'no', model: 'qwen3-vl-plus' });
  });
});

describe('агент не перезаписывает решение человека и не публикует «не смог»', () => {
  const SRC = readFileSync('app/api/cron/user-photo-moderate/route.ts', 'utf8');
  it('статус пишется только поверх pending', () => {
    expect(SRC).toMatch(/WHERE id::text = \$1 AND status = 'pending'/);
  });
  it('«человеку» статус не меняет', () => {
    expect(SRC).toMatch(/CASE WHEN \$3::text IN \('approved', 'rejected'\) THEN \$3::text ELSE status END/);
  });
  it('зрение не ответило — вердикт не пишется', () => {
    expect(SRC).toMatch(/if \(!result\.text && !duplicateOf\)[\s\S]{0,200}continue;/);
  });
});

describe('загрузка по правилам наших фото', () => {
  const API = readFileSync('app/api/places/[id]/photos/route.ts', 'utf8');
  it('снимок разворачивается, ужимается и уходит без метаданных (геометки)', () => {
    expect(API).toMatch(/sharp\([\s\S]{0,80}\)\s*\.rotate\(\)\s*\.resize\(1600, 1600/);
    expect(API).not.toMatch(/withMetadata|keepExif|keepMetadata/);
    expect(API).toMatch(/uploadToS3\(key, buf, 'image\/jpeg'\)/);
  });
  it('исходник, который не разобрался, не уходит в хранилище', () => {
    const fail = API.indexOf('Не удалось прочитать снимок');
    expect(fail).toBeGreaterThan(-1);
    expect(fail).toBeLessThan(API.indexOf('uploadToS3('));
  });
});

describe('согласие называет зарубежную проверку (152-ФЗ, трансграничная передача)', () => {
  it('текст галочки говорит, что снимок увидит сервис за пределами России', () => {
    const FORM = readFileSync('components/places/PhotoUpload.tsx', 'utf8');
    expect(FORM).toMatch(/сервис распознавания изображений за пределами России/);
  });
});
