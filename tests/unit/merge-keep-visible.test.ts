/**
 * При слиянии остаётся ВИДИМАЯ запись.
 *
 * 14.08 правило выбора взвешивало фото и профиль безопасности и не смотрело на
 * видимость. На паре Авачинского оно оставило скрытую запись и убрало видимую:
 * среди 145 мест типа «вулкан» не осталось ни одной видимой записи самого
 * известного вулкана Камчатки.
 *
 * Логика веса: карточка, которой не видно, не показывает НИЧЕГО — ни фото, ни
 * профиля безопасности. Значит видимая запись беднее данными всё равно лучше
 * богатой, но скрытой. Чтобы эта цена не была настоящей, слияние теперь
 * ПЕРЕНОСИТ профиль безопасности, если у оставшегося своего нет, — иначе
 * «предпочитать видимую» означало бы иногда терять данные о безопасности
 * места, а это на этой платформе недопустимо.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepScore } from '@/app/api/cron/places-dedup/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const SRC = read('app/api/cron/places-dedup/route.ts');
const MIGRATION = read('migrations/850_restore_visibility_lost_to_merge.sql');
const strip = (s: string) => s.replace(/^\s*--.*$/gm, '');

describe('видимость перевешивает данные', () => {
  it('видимая без данных бьёт скрытую с фото и профилем', () => {
    // Ровно случай Авачинского.
    expect(keepScore(true, false, false)).toBeGreaterThan(keepScore(false, true, true));
  });

  it('при равной видимости решают данные', () => {
    expect(keepScore(true, true, true)).toBeGreaterThan(keepScore(true, true, false));
    expect(keepScore(true, true, false)).toBeGreaterThan(keepScore(true, false, true));
  });

  it('две скрытые сравниваются по данным, а не вничью', () => {
    expect(keepScore(false, true, false)).toBeGreaterThan(keepScore(false, false, true));
  });
});

describe('видимость доезжает до правила из запроса', () => {
  it('обе стороны пары несут is_visible', () => {
    // Поле, объявленное в типе, но не выбранное запросом, пришло бы undefined
    // и молча считалось бы «не видно» — та же подмена, что уже стоила
    // 63 часов слепого мониторинга.
    expect(SRC).toMatch(/p1\.is_visible AS visible1/);
    expect(SRC).toMatch(/p2\.is_visible AS visible2/);
    expect(SRC).toMatch(/keepScore\(r\.visible1,/);
    expect(SRC).toMatch(/keepScore\(r\.visible2,/);
  });
});

describe('профиль безопасности переезжает, а не сиротеет', () => {
  it('переносится, если у оставшегося своего нет', () => {
    expect(SRC).toMatch(/UPDATE location_safety_profile\s*\n?\s*SET agent_route_id/);
    expect(SRC).toMatch(/NOT EXISTS \(\s*\n?\s*SELECT 1 FROM location_safety_profile/);
  });

  it('чужой профиль не затирается', () => {
    // Если профиль есть у обоих — оставляем профиль keeper'а и говорим об этом.
    expect(SRC).toMatch(/у обоих мест свой safety-профиль/);
  });
});

describe('ремонт уже случившегося', () => {
  it('миграция возвращает видимость только там, где слитое было видимым', () => {
    // «Раскрыть всех keeper-ов» вывело бы на витрину намеренно скрытое —
    // имена-неместа вроде «Скитур на Мутновский вулкан».
    const sql = strip(MIGRATION);
    expect(sql).toMatch(/SET is_visible = true/);
    expect(sql).toMatch(/m\.is_visible = true/);
    expect(sql).toMatch(/k\.is_visible = false/);
  });

  it('ремонт не трогает сами слитые записи', () => {
    expect(strip(MIGRATION)).toMatch(/k\.merged_into_id IS NULL/);
  });
});
