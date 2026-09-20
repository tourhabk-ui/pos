// @vitest-environment node
/**
 * Удаление генерации убирает И строку, И объект в хранилище.
 *
 * ── Что нашлось 19.09 ─────────────────────────────────────────────────────
 *
 * Владелец: «генерации не показывай, там всё не соответствует, генерации
 * удали». Перед запуском удаления оказалось, что оно НЕПОЛНОЕ.
 *
 * `images-generated` удалял строку из `ai_route_images` и не трогал объект в
 * S3. Пока снимки лежали байтами в базе, это совпадало: удалил строку —
 * удалил снимок. Но с 18.09 идёт переезд в хранилище (§4.1): у перевезённой
 * строки `image_data` обнулён, а картинка живёт объектом по `s3_key`.
 *
 * Для таких строк удаление оставляло ОБЪЕКТ-СИРОТУ: картинка продолжает
 * занимать оплаченное место, а найти её больше нечем — единственная ссылка на
 * ключ лежала в удалённой строке. Удаление, оставляющее ровно то, что просили
 * удалить, — не удаление.
 *
 * ── Почему объект первым ──────────────────────────────────────────────────
 *
 * Порядок выбран по ВОССТАНОВИМОСТИ, а не по удобству: не удалился объект —
 * строка остаётся, снимок цел, партию можно повторить. Обратный порядок терял
 * бы ключ при первой же ошибке сети, и мусор в хранилище стал бы ненаходимым.
 *
 * Та же логика, что у переезда в §4.1: сначала убедиться, потом обнулять.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/images-generated/route.ts'), 'utf-8');
/** Код без комментариев — запреты и порядок проверяются по нему. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('удаляется и объект, и строка', () => {
  it('объект в хранилище убирается', () => {
    expect(CODE).toContain('deleteFromS3(item.s3_key)');
  });

  it('ключ объекта доезжает до удаления через план', () => {
    expect(CODE).toContain('i.s3_key');
    expect(CODE).toMatch(/s3_key:\s*r\.s3_key/);
  });

  it('сначала объект, потом строка — порядок восстановим', () => {
    const objAt = CODE.indexOf('deleteFromS3(');
    const rowAt = CODE.indexOf('DELETE FROM ai_route_images');
    expect(objAt).toBeGreaterThan(0);
    expect(rowAt).toBeGreaterThan(0);
    expect(objAt, 'строка удаляется раньше объекта — ключ потеряется при сбое').toBeLessThan(rowAt);
  });

  it('объект не удалился — строка НЕ трогается, и причина названа', () => {
    const at = CODE.indexOf('deleteFromS3(');
    const branch = CODE.slice(at, at + 600);
    expect(branch).toContain('continue;');
    expect(branch).toMatch(/failed\.push/);
    expect(SRC).toContain('объект в хранилище не удалён');
  });

  it('отказ хранилища не глушится', () => {
    expect(SRC).toMatch(/console\.error\(`\[images-generated\] объект/);
  });

  it('строка без ключа удаляется как раньше — байты в базе, объекта нет', () => {
    expect(CODE).toContain('if (item.s3_key && isS3Configured)');
  });
});

describe('правила партии не ослаблены', () => {
  it('сухой прогон по умолчанию', () => {
    expect(CODE).toContain('dry_run: z.boolean().default(true)');
  });

  it('причина обязательна и не формальная', () => {
    expect(CODE).toMatch(/reason:\s*z\.string\(\)\.min\(10/);
  });

  it('партия не больше десяти', () => {
    expect(CODE).toContain('const MAX_BATCH = 10');
    expect(CODE).toMatch(/\.max\(MAX_BATCH\)/);
  });

  it('род повторён в самом DELETE — между планом и удалением снимок мог смениться', () => {
    expect(CODE).toMatch(/DELETE FROM ai_route_images[\s\S]{0,120}model = ANY/);
  });

  it('сухой прогон показывает, где снимок лежит, до всякого удаления', () => {
    expect(CODE).toMatch(/storage:\s*r\.s3_key \?/);
  });
});
