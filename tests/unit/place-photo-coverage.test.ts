// @vitest-environment node
/**
 * «У места есть фото» и «турист увидит фото» — разные утверждения.
 *
 * ── Повод (19.09) ─────────────────────────────────────────────────────────
 *
 * Владелец трижды за вечер спросил одно и то же разными словами: «где фото»,
 * «почему было и куда делось», «почему на Козельском нет фото». Каждый раз
 * ответ приходилось собирать заново, и каждый раз он выходил другим.
 *
 * Общее у трёх случаев не причина, а то, что причину НЕЛЬЗЯ БЫЛО СПРОСИТЬ.
 * Снимков в базе больше шести сотен, показывается меньше пятой части:
 * скрейп с чужого сайта (149), генерации (75) и чужие снимки без автора (23)
 * не показываются — каждое по своей причине, и каждая причина правильная. Но
 * вместе они дают состояние, где место «со снимком» неотличимо от места без
 * снимка ни с экрана, ни из кода.
 *
 * Хуже того, счёт обеспеченности считался по НАЛИЧИЮ строки: крон
 * `backfill-place-images` пишет месту генерацию и считает его обеспеченным, а
 * карточка эту генерацию не показывает с 17.07. То есть работа отчитывалась
 * об успехе, которого человек не видит.
 *
 * Сторож держит то, что отличает эту перепись от прежних: она считает
 * ПОКАЗЫВАЕМОЕ, разделяет три состояния и ничего не пишет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';
import { MANUAL_ENDPOINTS, DECLARED } from '@/lib/agents/cron-schedulers';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/place-photo-coverage/route.ts'), 'utf-8');
/** Код без комментариев — запреты проверяются только по нему. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('перепись считает показываемое, а не строки в таблице', () => {
  it('условие показа берётся из единого источника, а не пишется литералом', () => {
    expect(SRC).toContain("from '@/lib/images/origin'");
    expect(SRC).toContain('shownPhotoSql');
    // Литерал `model IN ('wikimedia', ...)` — та самая болезнь на тринадцать
    // файлов, которую origin.ts и лечил.
    expect(CODE).not.toMatch(/model\s+IN\s*\(\s*'/i);
  });

  it('три состояния разделены, а не сведены к «есть/нет»', () => {
    expect(SRC).toContain('with_shown_photo');
    expect(SRC).toContain('with_hidden_photo_only');
    expect(SRC).toContain('with_no_photo_at_all');
  });

  it('у скрытого снимка названа ПРИЧИНА, а не только род', () => {
    expect(SRC).toContain('function whyHidden');
    expect(SRC).toContain('hidden_by_model');
    for (const reason of ['генерация', 'лицензия требует автора', 'скрейп']) {
      expect(SRC, `причина «${reason}» должна называться словами`).toContain(reason);
    }
  });

  it('причины скрытия не выдуманы: роды берутся из origin, а не перечислены заново', () => {
    expect(SRC).toContain('GENERATED_MODELS');
  });
});

describe('вопрос про одно место отвечается словами', () => {
  it('есть параметр name и он ограничен по длине', () => {
    expect(SRC).toContain("url.searchParams.get('name')");
    expect(SRC).toMatch(/\.slice\(0, \d+\)/);
  });

  it('«места не нашлось» не выдаётся за «у места нет снимка»', () => {
    expect(SRC).toContain('живого места с таким именем не нашлось');
  });

  it('вердикт различает «снимка нет» и «снимок есть, но скрыт»', () => {
    expect(SRC).toContain('снимка нет вовсе');
    expect(SRC).toContain('снимок ЕСТЬ, но скрыт');
  });

  it('имя уходит в запрос параметром, а не склейкой', () => {
    expect(CODE).toContain("ILIKE '%' || $1 || '%'");
    expect(CODE).not.toMatch(/ILIKE\s*'%\$\{/);
  });
});

describe('перепись читающая и объявленная', () => {
  it('ни одного UPDATE/INSERT/DELETE', () => {
    expect(CODE).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i);
  });

  it('считает только живые места', () => {
    expect(CODE).toContain('is_visible IS NOT FALSE');
    expect(CODE).toContain('merged_into_id IS NULL');
  });

  it('род запуска и возможности объявлены', () => {
    expect(MANUAL_ENDPOINTS['place-photo-coverage']).toBeDefined();
    expect(MANUAL_ENDPOINTS['place-photo-coverage']?.writes).toBe(false);
    expect(DECLARED['place-photo-coverage']).toBeDefined();
    expect(CRON_CAPABILITIES['place-photo-coverage']).toEqual(['db_read']);
  });

  it('отказ не глушится: SQLSTATE в лог и в ответ', () => {
    expect(SRC).toContain('console.error');
    expect(SRC).toContain('sqlstate');
  });
});
