/**
 * Диагностика не должна устаревать молча.
 *
 * `/api/admin/diagnostics/bystraya` заводился ровно для вопроса «почему правки
 * тура не доезжают до карточки». К 05.08 он на этот вопрос отвечать перестал, и
 * никто этого не заметил:
 *
 *   • имя тура было вписано в код константой `TOUR_TITLE = 'Однодневная
 *     экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ'`, а миграция 806 переименовала тур в
 *     «Сплав по реке Быстрая» — матч перестал находить что-либо, и вердикт
 *     звучал «тур НЕ найден». Это ложь про живой опубликованный тур;
 *   • список проверяемых миграций обрывался на 800, то есть 806, 809, 810 и
 *     весь ряд 814–821 не проверялись вовсе.
 *
 * Инструмент, который врёт уверенно, хуже отсутствующего: по нему принимают
 * решения. Поэтому сторож требует, чтобы диагностика не могла отстать от
 * данных — ни по названию, ни по списку миграций.
 *
 * Этот файл заменяет `bystraya-diagnostics.test.ts`. Тот сторож не просто
 * пропускал устаревание — он его ЗАКРЕПЛЯЛ: требовал наличия строки
 * '789_bystraya_tour_publish.sql' в коде роута, то есть настаивал на
 * вписанном руками списке миграций. Сторож, охраняющий неверный приём,
 * работает против того, ради чего заведён.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(
  join(ROOT, 'app/api/admin/diagnostics/bystraya/route.ts'),
  'utf-8',
);

/** Исходник без строк-комментариев: пояснения не должны считаться кодом. */
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('диагностика не устаревает молча', () => {
  it('название тура не вписано в код', () => {
    // Любое имя тура в коде живёт до первой миграции, которая его сменит.
    expect(code).not.toMatch(/Однодневная экскурсия/);
    expect(code).not.toMatch(/TOUR_TITLE/);
    expect(code).not.toMatch(/ot\.title\s*=\s*\$/);
  });

  it('туры ищутся по содержанию', () => {
    expect(code).toMatch(/title ILIKE '%быстр%'/);
  });

  it('отдаются ВСЕ подходящие туры, без выбора одного', () => {
    // Гипотеза «правили не тот тур» проверяется только полным списком:
    // «канонический» ORDER BY ... LIMIT 1 — как раз главный подозреваемый.
    expect(code).not.toMatch(/LIMIT 1/);
    expect(code).toMatch(/rafting_tours/);
  });

  it('список миграций считается из каталога, а не пишется руками', () => {
    expect(code).toMatch(/readdirSync/);
    expect(code).toMatch(/_migrations/);
    // Никаких перечислений вида '796_...sql' в коде.
    expect(code).not.toMatch(/'\d{3}_[a-z_]+\.sql'/);
  });

  it('причины падений берутся целиком, а не по списку имён', () => {
    expect(code).toMatch(/FROM _migration_failures ORDER BY name/);
    expect(code).not.toMatch(/_migration_failures WHERE name = ANY/);
  });
});

describe('диагностика отвечает на нынешний вопрос', () => {
  it('показывает реальные типы колонок состава', () => {
    // Главная гипотеза: на проде included/not_included/what_to_bring — jsonb,
    // а не text[], и потому все ARRAY-миграции падали.
    expect(code).toMatch(/information_schema\.columns/);
    expect(code).toMatch(/udt_name/);
    for (const col of ['included', 'not_included', 'what_to_bring']) {
      expect(code).toContain(`'${col}'`);
    }
  });

  it('показывает фактическое содержимое состава тура', () => {
    // Без этого «починено или нет» опять решается на глаз по скриншоту.
    expect(code).toMatch(/ot\.not_included/);
    expect(code).toMatch(/ot\.included/);
  });

  it('показывает состояние публикации каждого тура', () => {
    // Раньше это был один булев `visible_in_catalog` по одному туру, найденному
    // по вписанному имени. Теперь — состояние каждой найденной строки.
    for (const field of ['is_active', 'is_published', 'deleted_at']) {
      expect(code).toContain(field);
    }
  });

  it('вердикт объясняется словами, а не только полями', () => {
    expect(code).toMatch(/verdict/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS молча/);
  });

  it('только чтение — никаких правок данных', () => {
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP)\s/);
  });

  it('доступ только администратору', () => {
    expect(code).toMatch(/requireAdmin/);
  });
});
