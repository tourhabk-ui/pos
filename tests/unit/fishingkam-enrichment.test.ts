/**
 * Глубина партнёра «Камчатская рыбалка» (сравнительный аудит владельца
 * 08.08: карточка сильнее средней витрины, но упущена глубина партнёра
 * как базы; зимние/весенние туры пропущены намеренно — слово владельца).
 *
 * Все факты миграции 842 сняты с сайта партнёра fishingkam.ru пробой
 * 08.08 (run 31280880387) — ни одна цифра не выдумана (§8). Проба же
 * показала, что «битые фото» аудита — ложная тревога: __.jpeg и
 * __.640.webp отдаются с прода кодом 200.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, 'migrations/842_fishingkam_enrichment.sql'), 'utf-8');
const CARD = readFileSync(join(ROOT, 'app/marketplace/tours/[id]/_TourDetailClient.tsx'), 'utf-8');

describe('842: условия с цифрами и порогами', () => {
  it('минимальная группа 5 — как на сайте партнёра', () => {
    expect(MIG).toMatch(/min_participants = 5/);
  });

  it('трансфер с порогом «от 7 000 ₽», одежда своя, повар по договорённости', () => {
    expect(MIG).toContain('от 7 000 ₽');
    expect(MIG).toContain('Одежда и обувь для рыбалки — свои');
    expect(MIG).toContain('Повар — по договорённости');
  });

  it('только актуальные туры 5 и 6, только этот оператор', () => {
    expect(MIG).toMatch(/ot\.id IN \(5, 6\)/);
    expect(MIG).toMatch(/name ILIKE '%камчатская рыбалка%'/);
  });

  it('зимние/весенние туры намеренно не создаются: миграция только UPDATE', () => {
    expect(MIG).not.toMatch(/INSERT INTO operator_tours/i);
  });
});

describe('842: база как продукт', () => {
  it('корпус 400 м² и состав номеров — из раздела «Размещение» сайта', () => {
    expect(MIG).toContain('400 м²');
    expect(MIG).toContain('семейный четырёхместный');
    expect(MIG).toMatch(/NOT LIKE '%400 м²%'/); // идемпотентность
  });
});

describe('842: программа дня', () => {
  it('ставится только там, где программы нет — операторская правка не перетирается', () => {
    expect(MIG).toMatch(/ot\.program IS NULL OR jsonb_array_length\(ot\.program\) = 0/);
  });

  it('честность сохранена: чавыча «не гарантирована», как пишет сам партнёр', () => {
    expect(MIG).toContain('не гарантирована');
  });

  it('уха на берегу и гид — из текста партнёра, не выдумка', () => {
    expect(MIG).toContain('уху из свежего улова прямо на берегу');
  });
});

describe('карточка: сайт оператора', () => {
  it('кнопка «Сайт оператора» рендерится из contacts.website с проверкой https', () => {
    expect(CARD).toMatch(/Сайт оператора/);
    expect(CARD).toMatch(/o\.website === 'string'/);
    expect(CARD).toMatch(/\^https:\\\/\\\//);
  });

  it('иконка глобуса для site-контакта', () => {
    expect(CARD).toMatch(/c\.icon === 'site' \? <Globe/);
  });
});
