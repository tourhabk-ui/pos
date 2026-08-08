/**
 * Телефоны «Камчатской рыбалки» на карточке тура (владелец 08.08:
 * «посмотрел карточки камчатской рыбалки — там нет телефонов партнеров»,
 * затем прислал номера и часы).
 *
 * Причина была в данных, не в коде: contacts партнёра содержал только
 * Telegram и TikTok (834), phone никто не записывал. Миграция 840 добавляет
 * оба номера и часы звонков; карточка рендерит часы отдельной строкой.
 * Телефоны — ТОЛЬКО из слова владельца, не из «поиска в интернете» (§8).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIG = readFileSync(join(ROOT, 'migrations/840_kamfishing_phones.sql'), 'utf-8');
const CARD = readFileSync(join(ROOT, 'app/marketplace/tours/[id]/_TourDetailClient.tsx'), 'utf-8');

describe('840: телефоны партнёра', () => {
  it('оба номера владельца, нормализованные для tel:', () => {
    expect(MIG).toContain("'phone',  '+79992997007'");
    expect(MIG).toContain("'phone2', '+79147822222'");
  });

  it('часы звонков — в камчатском времени (турист звонит с полуострова)', () => {
    expect(MIG).toContain('09:00–19:00 по Камчатке');
    expect(MIG).toContain('00:00–10:00 МСК');
  });

  it('идемпотентно: guard по IS DISTINCT FROM, адресат — только рыбалка', () => {
    expect(MIG).toMatch(/IS DISTINCT FROM/);
    expect(MIG).toMatch(/name ILIKE '%камчатская рыбалка%'/);
  });
});

describe('841: поправка номеров + личный Telegram (второе сообщение владельца)', () => {
  const MIG841 = readFileSync(join(ROOT, 'migrations/841_kamfishing_phones_fix.sql'), 'utf-8');

  it('номер 999 из 840 заменён верным, второй совпал', () => {
    expect(MIG841).toContain("'phone',  '+79247808011'");
    expect(MIG841).toContain("'phone2', '+79147822222'");
  });

  it('личный ТГ хранится username-ом, отдельно от канала', () => {
    expect(MIG841).toContain("'telegram_contact', 'labanalex'");
    expect(MIG841).not.toMatch(/telegram_channel/);
  });

  it('идемпотентно и адресно, как 840', () => {
    expect(MIG841).toMatch(/IS DISTINCT FROM/);
    expect(MIG841).toMatch(/name ILIKE '%камчатская рыбалка%'/);
  });

  it('карточка рендерит личный чат кнопкой «Написать в Telegram», канал — «Telegram-канал»', () => {
    expect(CARD).toMatch(/telegram_contact/);
    expect(CARD).toMatch(/Написать в Telegram/);
    expect(CARD).toMatch(/Telegram-канал/);
  });
});

describe('карточка показывает часы звонков', () => {
  it('phone_hours читается из contacts и рендерится под кнопками', () => {
    expect(CARD).toMatch(/phone_hours/);
    expect(CARD).toMatch(/Звонки: \{phoneHours\}/);
  });

  it('два номера рендерятся самими номерами (логика toContacts не тронута)', () => {
    expect(CARD).toMatch(/phone\.length >= 11 && phone2\.length >= 11/);
  });
});
