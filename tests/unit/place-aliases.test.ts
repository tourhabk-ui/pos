/**
 * У места одно имя и много псевдонимов.
 *
 * Слово владельца 14.08: «в разных источниках одно и то же место называется
 * по-разному, из-за этого и путаница». Это точная диагностика: у `places` есть
 * `source_name` — ОДИН источник на строку, и класть второе имя того же вулкана
 * было некуда. Поэтому второй источник заводил вторую строку. Дубли тут не
 * сбой импорта, а единственный способ хранить второе название.
 *
 * Три вещи, которые здесь охраняются:
 *
 *   1. Слияние ПИШЕТ имя, а не роняет его. 14.08 за один прогон исчезли
 *      «Авачинский вулкан», «Гора Шишель», «Вулкан Шивелуч», «Кутхины Баты».
 *   2. Поиск ищет по псевдонимам, иначе п.1 бессмыслен.
 *   3. Публичные чтения знают про merged_into_id. До этого его уважали только
 *      админка и кроны дедупа, и 27 слитых записей продолжали находиться и
 *      открываться отдельными карточками — при том что админка писала
 *      «скрыто из публички». `is_visible` слияние не трогает, так что это
 *      было неправдой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MATCHES_NAME_OR_ALIAS, NOT_MERGED } from '@/lib/places/aliases';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const MIGRATION = read('migrations/849_place_aliases.sql');
const DEDUP = read('app/api/cron/places-dedup/route.ts');

describe('фрагменты правил собраны в одном месте', () => {
  it('совпадение по имени включает псевдонимы', () => {
    const sql = MATCHES_NAME_OR_ALIAS('p', '$1');
    expect(sql).toContain('p.name ILIKE $1');
    expect(sql).toContain('place_aliases');
  });

  it('«живое место» — это не слитое', () => {
    expect(NOT_MERGED('p')).toBe('p.merged_into_id IS NULL');
  });
});

describe('миграция не повторяет ошибку, убившую четыре предыдущие', () => {
  it('place_id — TEXT и без внешнего ключа', () => {
    // `places.id` в проде TEXT (UUID лежит в ark_id) — установлено пробой
    // 14.08. Inline-FK `REFERENCES places(id)` из-за этого падает: так погибла
    // миграция 675 (таблица не создалась) и 706/731/733/734, пока 737 не
    // выбросила FK у merged_into_id.
    const code = strip(MIGRATION);
    expect(code).toMatch(/place_id\s+TEXT NOT NULL/);
    expect(code).not.toMatch(/REFERENCES\s+places/);
  });

  it('идемпотентна', () => {
    const code = strip(MIGRATION);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS place_aliases/);
    expect(code.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g)?.length).toBeGreaterThanOrEqual(4);
    expect(code).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('бэкфилл возвращает имена прошлых слияний', () => {
    // Иначе таблица заводится пустой, а уже проглоченные имена так и остаются
    // проглоченными — правка была бы только на будущее.
    const code = strip(MIGRATION);
    expect(code).toMatch(/INSERT INTO place_aliases/);
    expect(code).toMatch(/merged_into_id IS NOT NULL/);
  });

  it('имя, совпадающее с именем оставшегося места, псевдонимом не становится', () => {
    // «Курильское озеро» → «Курильское озеро» это не второе название, а шум.
    expect(strip(MIGRATION)).toMatch(/LOWER\(TRIM\(m\.name\)\) <> LOWER\(TRIM\(COALESCE\(k\.name/);
  });
});

describe('слияние сохраняет имя', () => {
  it('пишет псевдоним оставшемуся месту', () => {
    expect(DEDUP).toMatch(/recordAlias\(client, p\.keepId, p\.mergeName/);
  });

  it('переносит и чужие псевдонимы, а не только имя', () => {
    // Цепочка A ← B ← C: если у B был псевдоним, при слиянии B в A он обязан
    // переехать, иначе перестанет находить что-либо ровно тогда, когда стал
    // нужнее.
    expect(DEDUP).toMatch(/moveAliases\(client, p\.mergeId, p\.keepId\)/);
  });

  it('источник имени сохраняется вместе с именем', () => {
    // Псевдоним без источника — снова безымянное второе название: непонятно,
    // кто так называет место и можно ли этому верить.
    expect(DEDUP).toMatch(/SELECT source_name FROM places/);
  });
});

describe('публичные чтения знают про слияние', () => {
  const CASES: Array<[string, string]> = [
    ['поиск Ctrl+K', 'app/api/search/route.ts'],
    ['автокомплит мест', 'app/api/places/route.ts'],
    ['карточка места (API)', 'app/api/places/[id]/route.ts'],
  ];

  for (const [label, file] of CASES) {
    it(`${label} не показывает слитые записи`, () => {
      expect(strip(read(file))).toMatch(/merged_into_id IS NULL|NOT_MERGED\(/);
    });
  }

  it('страница места уводит 301 на оставшееся', () => {
    // Не 404: ссылки и выдача поисковиков на старый адрес существуют и должны
    // приводить к живому месту, а не в пустоту.
    const page = read('app/places/[id]/page.tsx');
    expect(page).toMatch(/resolveMergedTarget\(id\)/);
    expect(page).toMatch(/permanentRedirect\(`\/places\/\$\{mergedTo\.canonical\}`\)/);
  });

  it('«рядом» не предлагает слитые места', () => {
    // Иначе соседний блок карточки — витрина мёртвых ссылок.
    const api = strip(read('app/api/places/[id]/route.ts'));
    expect(api.match(/merged_into_id IS NULL/g)?.length).toBe(2);
  });
});

describe('поиск по псевдонимам действительно подключён', () => {
  it('оба поиска используют общий фрагмент, а не свой', () => {
    // Своя копия условия — это четвёртое правило об одном и том же; в этом
    // репозитории так уже разъехались стиль линии, сравнение секретов и адрес
    // формы МЧС.
    expect(read('app/api/search/route.ts')).toMatch(/MATCHES_NAME_OR_ALIAS\('p', '\$1'\)/);
    expect(read('app/api/places/route.ts')).toMatch(/MATCHES_NAME_OR_ALIAS\('p',/);
  });
});
