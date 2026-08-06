/**
 * Второй номер оператора: доезжает до карточки и не теряется молча.
 *
 * Владелец 06.08: «добавить второй номер +79247901911 в сплавы». Примечательно:
 * выдуманный в 060 номер +79247990191 оказался почти этим — те же цифры,
 * переставленные местами. В марте настоящий второй номер был искажён, а не
 * сочинён с нуля; для туриста «почти правильный» телефон хуже отсутствующего.
 *
 * Сторож держит: миграция кладёт номер вторым (основной от Ярослава не
 * трогается), карточка умеет показывать оба, и при двух номерах на кнопках —
 * сами номера: две одинаковые кнопки «Позвонить» не говорят, чем отличаются.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const M830 = readFileSync(join(ROOT, 'migrations/830_rafting_second_phone.sql'), 'utf-8');
const CARD = readFileSync(join(ROOT, 'app/marketplace/tours/[id]/_TourDetailClient.tsx'), 'utf-8');
const sql = M830.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('миграция 830', () => {
  it('кладёт второй номер, не трогая основной', () => {
    expect(sql).toContain("'phone2', '+79247901911'");
    expect(sql).not.toMatch(/'phone',/);
  });

  it('только оператор сплава', () => {
    expect(sql).toContain("slug = 'kamchatka-rafting'");
  });

  it('идемпотентна', () => {
    expect(sql).toMatch(/IS DISTINCT FROM/);
  });

  it('источник назван — это требование к любым контактам в миграциях', () => {
    expect(M830).toMatch(/владелец, 06\.08/);
  });
});

describe('карточка тура', () => {
  it('читает phone2', () => {
    expect(CARD).toMatch(/o\.phone2/);
  });

  it('при двух номерах на кнопках — сами номера', () => {
    expect(CARD).toMatch(/formatPhone\(phone\)/);
    expect(CARD).toMatch(/formatPhone\(phone2\)/);
  });

  it('один номер — прежняя кнопка «Позвонить»', () => {
    expect(CARD).toMatch(/label: 'Позвонить'/);
  });
});
