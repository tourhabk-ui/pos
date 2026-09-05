// @vitest-environment node
/**
 * Слово паспорта о регистрации в МЧС (05.09).
 *
 * Слияния 04-05.09 дважды показали одну картину: выживший маршрут нёс
 * mchs_registration_required = false, дубль с официальным паспортом — true.
 * Правило переноса честно оставило false: это значение, не пустота. Но у
 * колонки DEFAULT false, а выжившие пришли скрейпом, где флага нет вовсе —
 * то есть false никто не говорил. Карточка показывала телефон МЧС и молчала
 * о том, что регистрация обязательна.
 *
 * Два сторожа: миграция 933 чинит две записи поимённо и не притворяется
 * общим правилом; перепись называет подозреваемых и не выносит вердикт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MIG = read('migrations/933_passport_flag_and_ghost_route.sql');
const CENSUS = read('app/api/cron/passport-flag-census/route.ts');
const DEDUP = read('app/api/cron/routes-dedup/route.ts');

describe('миграция 933: две записи поимённо, с уликой', () => {
  it('ставит флаг только выжившим из двух слияний', () => {
    expect(MIG).toContain('be1c6c4a-33d8-4b3f-8025-2230654758f2');
    expect(MIG).toContain('385d1c98-14d2-4173-bdb6-03eb5d596db0');
  });

  it('улика — паспорт visitkamchatka у записи, а не одно лишь имя', () => {
    // «Сказано false» и «дефолт false» по базе неотличимы; общее правило
    // «паспорт ⇒ true» здесь запрещено — паспорт может честно сказать «нет».
    expect(MIG).toMatch(/pdf_url ILIKE '%visitkamchatka\.ru%'/);
    expect(MIG).not.toMatch(/UPDATE kamchatka_routes\s+SET mchs_registration_required = true[^;]*WHERE pdf_url/i);
  });

  it('идемпотентна: оба UPDATE сужены на текущее состояние', () => {
    expect(MIG).toMatch(/mchs_registration_required IS DISTINCT FROM true/);
    expect(MIG).toMatch(/AND merged_into_id IS NULL\s+AND is_visible = true/);
  });

  it('призрак скрывается, а не удаляется', () => {
    expect(MIG).toContain('f447bbe2-37ef-4858-b5eb-d8014fbf50d2');
    expect(MIG).toMatch(/SET is_visible = false/);
    expect(MIG).not.toMatch(/DELETE FROM/i);
  });
});

describe('перепись флага называет подозреваемых, не вердикт', () => {
  it('объявлена ручной и только читающей', () => {
    expect(MANUAL_ENDPOINTS['passport-flag-census']).toBeTruthy();
    expect(MANUAL_ENDPOINTS['passport-flag-census']!.writes).toBe(false);
  });

  it('считает только живые записи с паспортом', () => {
    expect(CENSUS).toMatch(/r\.is_visible = true AND r\.merged_into_id IS NULL/);
    expect(CENSUS).toMatch(/r\.pdf_url IS NOT NULL/);
  });

  it('слово «подозреваемые» — в ответе, слова «неверен» — нет', () => {
    expect(CENSUS).toMatch(/suspects_total/);
    expect(CENSUS).not.toMatch(/flag_wrong|неверн/);
  });

  it('отказ переписи — «не смог», а не «подозреваемых нет»', () => {
    expect(CENSUS).toMatch(/verdict: 'unknown'/);
    expect(CENSUS).toMatch(/console\.error\('\[passport-flag-census\]/);
  });

  it('секрет сверяется до любого запроса к БД', () => {
    expect(CENSUS.indexOf('timingSafeCompare')).toBeLessThan(CENSUS.indexOf('pool.query'));
  });
});

describe('шапка routes-dedup не врёт о переносе', () => {
  it('после 04.09 паспортные поля переносятся — шапка обязана это говорить', () => {
    expect(DEDUP).not.toMatch(/паспортные поля НЕ переносятся/);
    expect(DEDUP).toMatch(/TRANSFER_FIELDS/);
  });
});
