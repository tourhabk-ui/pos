/**
 * Позиция проката попадает в каталог только после проверки, а профиль
 * прокатчика не выдаётся читающим запросом.
 *
 * ── Дыра в две двери (26.09) ──────────────────────────────────────────────
 *
 * Владелец попросил проверить роли разделов хаба. У проката нашлась цепочка
 * из двух запросов, доступная любому вошедшему туристу:
 *
 *   1. GET /api/gear/profile стоял на `requireAuth` и при отсутствии профиля
 *      САМ заводил партнёра `category='gear'` (`ensureGearPartnerExists`).
 *      Читающий запрос писал в базу и выдавал роль;
 *   2. POST /api/gear/items спрашивал только «есть ли профиль» — а он к этому
 *      моменту уже был создан первой дверью;
 *   3. публичный каталог (`findAvailableGear`) фильтровал
 *      `is_active AND available_quantity > 0` — ни проверки позиции, ни
 *      `is_verified` партнёра.
 *
 * Итог: турист за два запроса выставлял снаряжение на витрину платформы,
 * которая обещает проверенных партнёров. У ЖИЛЬЯ то же место закрыто с 26.09
 * (миграция 1027) и держится сторожем; у проката не было ни шлюза, ни отметки.
 *
 * Решение владельца: «как у жилья: модерация админом».
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Обе двери и оба обещания: условие витрины (одно на жильё и прокат),
 * невозможность самозаписи в роль, шлюз в базе на случай прямой ссылки и
 * честные слова партнёру о том, что с его позицией.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicGearSql, gearListingState, MODERATION_STATUSES } from '@/lib/gear/moderation';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { publicModeratedSql, moderatedKind } from '@/lib/moderation/gate';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const HELPERS = read('lib/auth/gear-helpers.ts');
const PROFILE = read('app/api/gear/profile/route.ts');
const ITEMS = read('app/api/gear/items/route.ts');
const MIGRATION = read('migrations/1030_gear_moderation.sql');

describe('условие витрины — одно на жильё и прокат', () => {
  it('прокат требует и активности, и одобрения', () => {
    const sql = publicGearSql('gi');
    expect(sql).toContain('gi.is_active = true');
    expect(sql).toContain("gi.moderation_status = 'approved'");
  });

  it('оба домена берут условие из общего места', () => {
    // Копия правила разошлась бы: у жилья условие стоит в шести читателях
    // витрины, у проката встало бы в своих (§12).
    expect(publicGearSql('x')).toBe(publicModeratedSql('x'));
    expect(publicAccommodationSql('x')).toBe(publicModeratedSql('x'));
  });

  it('алиас проверяется — подстановка в SQL без проверки однажды встретит чужую строку', () => {
    expect(() => publicGearSql("gi; DROP TABLE gear_items --")).toThrow();
  });

  it('публичный каталог зовёт шлюз, а не своё условие', () => {
    expect(code(HELPERS)).toMatch(/publicGearSql\('gi'\)/);
    expect(code(HELPERS), 'вернулось условие только по is_active')
      .not.toMatch(/WHERE\s+gi\.is_active = true\s*\n\s*AND gi\.available_quantity/);
  });
});

describe('исходы для партнёра названы словами', () => {
  const row = (status: string, active = true, reason: string | null = null) =>
    gearListingState({ is_active: active, moderation_status: status, moderation_reason: reason });

  it('на проверке — не в каталоге, и сказано почему', () => {
    const s = row('pending');
    expect(s.public).toBe(false);
    expect(s.detail).toContain('после проверки');
  });

  it('отказ несёт причину', () => {
    expect(row('rejected', true, 'Нет фотографий').detail).toContain('Нет фотографий');
  });

  it('отказ без записанной причины не молчит', () => {
    expect(row('rejected', true, null).detail).toContain('поддержку');
  });

  it('одобрено и включено — в каталоге', () => {
    expect(row('approved').public).toBe(true);
  });

  it('одобрено, но снято партнёром — не в каталоге', () => {
    const s = row('approved', false);
    expect(s.public).toBe(false);
    expect(s.label).toBe('Снято вами');
  });

  it('незнакомый статус — НЕ «в каталоге» (§4.0)', () => {
    const s = row('какой-то новый');
    expect(s.public).toBe(false);
    expect(moderatedKind({ is_active: true, moderation_status: 'какой-то новый' }).kind).toBe('unknown');
  });

  it('справочник статусов один', () => {
    expect([...MODERATION_STATUSES]).toEqual(['pending', 'approved', 'rejected']);
  });
});

describe('роль не выдаётся читающим запросом', () => {
  it('профиль больше не создаёт партнёра', () => {
    expect(code(PROFILE), 'GET/PUT профиля снова заводит роль')
      .not.toMatch(/ensureGearPartnerExists/);
  });

  it('нет профиля — честный отказ с объяснением, а не тихое превращение в партнёра', () => {
    expect(PROFILE).toContain('Профиль прокатчика не найден');
    expect(PROFILE).toMatch(/status:\s*404/);
  });

  it('создание позиции по-прежнему требует профиля', () => {
    expect(code(ITEMS)).toMatch(/getGearPartnerId\(userId\)/);
  });

  it('кабинет получает статус проверки — иначе партнёр не узнает, где его позиция', () => {
    expect(code(ITEMS)).toContain('moderation_status');
    expect(code(read('app/hub/gear/inventory/_InventoryClient.tsx'))).toMatch(/gearListingState\(/);
  });
});

describe('решение администратора — единственный писатель статуса', () => {
  const ADMIN = read('app/api/admin/gear/[id]/route.ts');

  it('роут закрыт админским гейтом', () => {
    expect(code(ADMIN)).toMatch(/requireAdmin\(request\)/);
  });

  it('отказ без причины не принимается', () => {
    expect(ADMIN).toMatch(/min\(5,/);
  });

  it('кто и когда решил — записывается', () => {
    expect(code(ADMIN)).toContain('moderated_by');
    expect(code(ADMIN)).toContain('moderated_at      = NOW()');
  });

  it('никто, кроме админского роута, не ставит approved', () => {
    // Иначе шлюз обходится изнутри: партнёрский путь сам себя одобрит.
    for (const rel of [
      'app/api/gear/items/route.ts',
      'app/api/gear/items/[id]/route.ts',
      'app/api/gear/profile/route.ts',
      'lib/auth/gear-helpers.ts',
    ]) {
      expect(code(read(rel)), `${rel} пишет статус проверки`)
        .not.toMatch(/moderation_status\s*=\s*'approved'/);
    }
  });
});

describe('шлюз стоит и в базе', () => {
  it('новая позиция по умолчанию на проверке', () => {
    expect(MIGRATION).toMatch(/ALTER COLUMN moderation_status SET DEFAULT 'pending'/);
  });

  it('статус ограничен справочником', () => {
    expect(MIGRATION).toMatch(/CHECK \(moderation_status IN \('pending', 'approved', 'rejected'\)\)/);
  });

  it('отказ без причины запрещён на уровне базы', () => {
    expect(MIGRATION).toContain('gear_items_rejection_has_reason');
  });

  it('аренда неодобренной позиции невозможна даже по прямой ссылке', () => {
    // Витрина её не покажет, но id мог утечь: старый кэш, ссылка из чата.
    expect(MIGRATION).toContain('trg_gear_rental_requires_approved');
    expect(MIGRATION).toMatch(/BEFORE INSERT ON gear_rentals/);
  });

  it('прежние позиции одобрены, а не спрятаны задним числом', () => {
    // До 26.09 заведение и БЫЛО публикацией; прятать живой каталог значило бы
    // наказать настоящих партнёров за отсутствие проверки.
    expect(MIGRATION).toMatch(/SET moderation_status = 'approved'\n\s*WHERE moderation_status IS NULL/);
  });

  it('миграция идемпотентна', () => {
    expect(MIGRATION).toContain('IDEMPOTENT');
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS moderation_status/);
  });
});
