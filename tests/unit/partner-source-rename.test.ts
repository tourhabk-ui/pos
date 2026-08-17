/**
 * Имя стороннего поставщика переименовано в «наши партнёры» и не ведёт наружу.
 *
 * Решение владельца 17.08. Полевой скрин показал «источник: idilesom» в
 * карточке качества данных; подвал карточки места печатал «Источник:
 * idilesom.com» кликабельной ссылкой.
 *
 * Про этот же источник миграция 767 писала прямым текстом: реклама конкурента,
 * которую вычищали из описаний. Турист, дочитавший нашу карточку места,
 * получал в конце дорогу к конкуренту.
 *
 * Переименование затрагивает ЗНАЧЕНИЯ, а не структуру (миграция 871):
 * in-band маркер геометрии становится 'partners', `source_name` — «наши
 * партнёры». Ссылка при этом обязана исчезнуть: подпись «наши партнёры»
 * поверх ссылки на чужой сайт обещает одно, а ведёт в другое.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gradeFromSource } from '@/lib/map/line-standard';

const MIGRATION = readFileSync(
  join(process.cwd(), 'migrations/871_rename_source_to_partners.sql'),
  'utf-8',
);
const FOOTER = readFileSync(join(process.cwd(), 'components/places/PlaceFooter.tsx'), 'utf-8');

describe('новый слог знают как снятый трек', () => {
  it('partners — снятый путь, не набросок', () => {
    // Переименование не имеет права понизить род линии: те же треки,
    // нарисованные пунктиром, звали бы обходить проверенную тропу.
    expect(gradeFromSource('partners')).toBe('surveyed');
  });

  it('прежний слог всё ещё узнаётся — ради полевых пакетов на телефонах', () => {
    // Снимок, сохранённый ДО миграции, лежит в IndexedDB и уже не изменится.
    // Забыв слог, мы объявили бы сохранённый трек незнакомым ровно там, где
    // связи нет и переспросить нечего.
    expect(gradeFromSource('idilesom')).toBe('surveyed');
  });

  it('незнакомый источник по-прежнему не считается треком', () => {
    expect(gradeFromSource('какой-то-новый')).toBeNull();
  });
});

describe('миграция переименовывает значения, а не режет происхождение', () => {
  it('маркер геометрии становится partners', () => {
    expect(MIGRATION).toMatch(/jsonb_build_object\('source', 'partners'\)/);
  });

  it('видимое имя источника — «наши партнёры» во всех написаниях', () => {
    // Написаний накопилось несколько: слог импортёра, домен (его подставил
    // data-repair), русское имя из скрейпа.
    expect(MIGRATION).toMatch(/source_name = 'наши партнёры'/);
    expect(MIGRATION).toMatch(/иди\\s\*лесом\|идилесом\|idilesom/);
    expect(MIGRATION).toMatch(/UPDATE kamchatka_routes/);
    expect(MIGRATION).toMatch(/UPDATE places/);
  });

  it('source_url остаётся — это проверяемость, а не витрина', () => {
    expect(MIGRATION).not.toMatch(/SET source_url\s*=\s*NULL/i);
  });

  it('идемпотентна и регистрируется', () => {
    expect(MIGRATION).toMatch(/871_rename_source_to_partners\.sql/);
    expect(MIGRATION).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
  });
});

describe('подвал карточки места не ведёт к чужому сайту под нашей подписью', () => {
  it('партнёрский источник печатается текстом, без ссылки', () => {
    expect(FOOTER).toMatch(/const PARTNER_SOURCE_NAME = 'наши партнёры'/);
    expect(FOOTER).toMatch(/partnerSource \? \(/);
  });

  it('ссылка остаётся для прочих источников', () => {
    // Атрибуция источника сама по себе честна — запрет адресный.
    expect(FOOTER).toMatch(/href=\{sourceUrl\}/);
  });
});
