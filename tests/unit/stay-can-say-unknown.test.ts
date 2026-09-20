/**
 * Витрина жилья умеет говорить «не знаю».
 *
 * ── Что чинилось 20.09 ────────────────────────────────────────────────────
 *
 * Владелец назвал «Снежную долину» базой отдыха и попросил завести её на
 * витрину. Не вышло: схема ТРЕБОВАЛА `total_rooms` (да ещё > 0),
 * `price_per_night_from` и `address`, а рейтинг ставила нулём. Ни числа
 * номеров, ни цены, ни адреса владелец не называл — чтобы завести запись,
 * их пришлось бы выдумать.
 *
 * Витрина была пуста не потому, что некому завести первую запись, а потому
 * что ЧЕСТНУЮ запись схема не принимала. Это §4.0 дословно: место, где
 * нельзя сказать «не знаю», заполняется враньём.
 *
 * ── Находка по дороге, и она дороже самой задачи ──────────────────────────
 *
 * Планер поездки отбирал жильё условием «rating >= 3.5», а новый объект
 * получал rating = 0 по умолчанию схемы. Ноль меньше трёх с половиной —
 * значит объект без отзывов не попадал в подбор НИКОГДА. Отзывы берутся из
 * броней, брони из подбора: круг замкнут. Строка при этом не падала, а
 * молча выпадала из выдачи, поэтому увидеть это можно было только чтением
 * SQL.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * 1. Схема допускает отсутствие, но не допускает бессмыслицы (ноль номеров
 *    и отрицательные — по-прежнему нельзя).
 * 2. Формы заведения не требуют того, чего может не быть.
 * 3. Пустота НИГДЕ не превращается в число: ни в ноль рублей, ни в NaN, ни
 *    в оценку. `Number(null)` равен нулю, `parseFloat(null)` равен NaN, и
 *    обе ловушки уже стреляли в этом репозитории.
 * 4. Неизвестное не притворяется ни лучшим, ни худшим при сортировке.
 * 5. Платформа больше не отсеивает неоценённое сама.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIGRATION = readFileSync(join(ROOT, 'migrations/1006_stay_can_say_unknown.sql'), 'utf-8');
const CATALOG   = readFileSync(join(ROOT, 'app/api/accommodations/route.ts'), 'utf-8');
const PLANNER   = readFileSync(join(ROOT, 'app/api/trip/plan/route.ts'), 'utf-8');
const CALENDAR  = readFileSync(join(ROOT, 'app/api/stay/calendar/route.ts'), 'utf-8');
const PRICES    = readFileSync(join(ROOT, 'app/api/accommodations/[id]/prices/route.ts'), 'utf-8');
const CARD      = readFileSync(join(ROOT, 'components/shared/AccommodationCard.tsx'), 'utf-8');
const OWNER_FORM = readFileSync(join(ROOT, 'app/api/stay/accommodations/route.ts'), 'utf-8');
const ADMIN_FORM = readFileSync(join(ROOT, 'app/api/accommodations/create/route.ts'), 'utf-8');

/**
 * Код без комментариев: прежние формы в шапках процитированы намеренно.
 *
 * У SQL своя форма комментария — два дефиса, — и её обязательно снимать
 * отдельно. Это четвёртый случай за день, когда сторож краснел на ПРОЗЕ
 * вместо кода: дважды ловил слово из комментария в TSX, один раз — имя
 * колонки, упомянутое в объяснении, и вот теперь имя таблицы в шапке
 * миграции. Отрицательная проверка обязана смотреть на то, что исполняется.
 */
function sqlCodeOnly(src: string): string {
  return src
    .split('\n')
    .map((l) => {
      const at = l.indexOf('--');
      return at === -1 ? l : l.slice(0, at);
    })
    .join('\n');
}

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const at = l.indexOf('//');
      return at === -1 ? l : l.slice(0, at);
    })
    .join('\n');
}

describe('схема допускает отсутствие, но не бессмыслицу', () => {
  it('три поля перестали быть обязательными', () => {
    for (const col of ['price_per_night_from', 'total_rooms', 'address']) {
      expect(MIGRATION, `${col} не отпущен`)
        .toMatch(new RegExp(`ALTER COLUMN ${col}\\s+DROP NOT NULL`));
    }
  });

  it('рейтинг больше не ставится нулём по умолчанию', () => {
    expect(MIGRATION).toMatch(/ALTER COLUMN rating DROP DEFAULT/);
  });

  it('ноль и отрицательные номера ЗАПРЕЩЕНЫ: «не знаю» это не «ноль»', () => {
    expect(MIGRATION).toMatch(/CHECK \(total_rooms IS NULL OR total_rooms > 0\)/);
  });

  it('цена КОМНАТЫ и координата остаются обязательными', () => {
    // По комнате считается сумма брони, по координате место находят на карте.
    // Это не вывески, а поля, без которых сущность не работает.
    //
    // Запрещается ДЕЙСТВИЕ, а не слово. Первая редакция запрещала подстроку
    // `accommodation_rooms` — и краснела на COMMENT ON, где имя таблицы
    // стоит по делу: пояснение к колонке говорит, где живёт настоящая цена.
    // Сторож, ловящий упоминание вместо правки, запрещает объяснять.
    const code = sqlCodeOnly(MIGRATION);
    expect(code).not.toMatch(/ALTER TABLE\s+accommodation_rooms/i);
    expect(code).not.toMatch(/ALTER COLUMN coordinates/i);
    expect(code).not.toMatch(/ALTER COLUMN\s+\w*price_per_night\b(?!_from)/i);
  });
});

describe('формы не требуют того, чего может не быть', () => {
  for (const [name, src] of [['владельца жилья', OWNER_FORM], ['админа', ADMIN_FORM]] as const) {
    it(`форма ${name}: адрес, номера и цена необязательны`, () => {
      const code = codeOnly(src);
      expect(code, 'адрес').toMatch(/address:\s*z\.string\(\)[^\n]*\.optional\(\)/);
      expect(code, 'номера').toMatch(/totalRooms:\s*z\.number\(\)[^\n]*\.optional\(\)/);
      expect(code, 'цена').toMatch(/pricePerNightFrom:\s*z\.number\(\)[^\n]*\.optional\(\)/);
    });
  }

  it('в базу уходит ЯВНЫЙ null, а не пропуск', () => {
    // Пропуск оставлял бы трактовку на драйвере; явный null говорит «не знаю»
    // одинаково всегда (тот же довод, что в миграции 1005).
    expect(OWNER_FORM).toMatch(/d\.address \?\? null/);
    expect(OWNER_FORM).toMatch(/d\.totalRooms \?\? null/);
    expect(OWNER_FORM).toMatch(/d\.pricePerNightFrom \?\? null/);
  });
});

describe('пустота не превращается в число', () => {
  it('каталог отдаёт null ценой и null оценкой, а не ноль', () => {
    const code = codeOnly(CATALOG);
    expect(code).toMatch(/row\.price_per_night_from === null \? null : parseFloat/);
    expect(code).toMatch(/row\.rating === null \? null : parseFloat/);
    // Прежняя форма превращала «не оценён» в ноль — и планер по этому нулю
    // отсеивал объект навсегда.
    expect(code).not.toMatch(/row\.rating \? parseFloat\(row\.rating\) : 0/);
    expect(code).not.toMatch(/from: parseFloat\(row\.price_per_night_from\)/);
  });

  it('календарь проверяет значение, а не только наличие строки', () => {
    const code = codeOnly(CALENDAR);
    expect(code).toMatch(/price_per_night_from == null \? null : Number/);
    expect(code).toMatch(/total_rooms == null \? null : Number/);
    // `base ? Number(base.price_per_night_from) : null` проверял СТРОКУ, а не
    // значение: при найденной строке с пустой ценой давал ноль рублей.
    expect(code).not.toMatch(/base \? Number\(base\.price_per_night_from\) : null/);
  });

  it('цены не отдают NaN под видом числа', () => {
    const code = codeOnly(PRICES);
    expect(code).toMatch(/basePrice === null \? null : parseFloat/);
    expect(code).not.toMatch(/basePrice: parseFloat\(basePrice\)/);
  });

  it('карточка показывает отсутствие цены словами', () => {
    expect(CARD).toMatch(/pricePerNight\.from === null/);
    expect(CARD).toMatch(/Цена по запросу/);
  });

  it('типы карточки допускают отсутствие — иначе выразить нечем', () => {
    expect(CARD).toMatch(/address:\s*string \| null/);
    expect(CARD).toMatch(/from:\s*number \| null/);
    expect(CARD).toMatch(/rating:\s*number \| null/);
  });

  it('адрес не выводится пустым местом', () => {
    expect(CARD).toMatch(/address \?\? 'Адрес не указан/);
  });
});

describe('неизвестное не притворяется ни лучшим, ни худшим', () => {
  it('сортировки по цене и оценке уводят пустое в конец', () => {
    const code = codeOnly(CATALOG);
    expect(code).toMatch(/price_asc: 'a\.price_per_night_from ASC NULLS LAST'/);
    expect(code).toMatch(/price_desc: 'a\.price_per_night_from DESC NULLS LAST'/);
    expect(code).toMatch(/rating_desc: 'a\.rating DESC NULLS LAST/);
  });

  it('в планере тоже — и по оценке, и по цене', () => {
    const code = codeOnly(PLANNER);
    expect(code).toMatch(/a\.rating DESC NULLS LAST/);
    expect(code).toMatch(/a\.price_per_night_from ASC NULLS LAST/);
  });
});

describe('платформа не отсеивает неоценённое сама', () => {
  it('планер допускает объект без оценки', () => {
    const code = codeOnly(PLANNER);
    expect(code).toMatch(/\(a\.rating IS NULL OR a\.rating >= 3\.5\)/);
    // Голое условие отсеивало объект без отзывов навсегда.
    expect(code).not.toMatch(/AND a\.rating >= 3\.5\s*$/m);
  });

  it('планер допускает объект без объявленной цены при заданном бюджете', () => {
    const code = codeOnly(PLANNER);
    expect(code).toMatch(/a\.price_per_night_from IS NULL OR a\.price_per_night_from <= \$1/);
  });

  it('фильтры, которые задал ТУРИСТ, остаются строгими', () => {
    // Разница по существу: диапазон цены человек спросил сам, и объект с
    // неизвестной ценой под него не подходит. Условие платформы он не просил.
    const code = codeOnly(CATALOG);
    expect(code).toMatch(/a\.price_per_night_from >= \$\$\{paramIndex\+\+\}/);
    expect(code).toMatch(/a\.price_per_night_from <= \$\$\{paramIndex\+\+\}/);
  });
});
