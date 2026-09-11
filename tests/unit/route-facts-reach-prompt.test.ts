/**
 * Поля маршрута доезжают до промпта Кузьмича, а незнание не выдаётся за «нет».
 *
 * ── Что было (#1818, разбор прогонов эвала 11-12) ──────────────────────────
 *
 * Запрос маршрутов выбирал три колонки: заголовок, описание, вид активности.
 * Рядом в той же таблице лежали `mchs_registration_required`, `mchs_phone`,
 * `distance_km`, `elevation_gain_m`, `difficulty`, `hazards`, `equipment`,
 * `park_name`, `season` — и до ответа не доходили.
 *
 * Поэтому на вопрос «нужна ли регистрация в МЧС на этот маршрут» Кузьмич
 * отвечал ПО ПАМЯТИ МОДЕЛИ. Регистрация обязательна на 154 маршрутах, и §8
 * говорит прямо: критичные факты — из инструментов и БД, самоотчёту модели не
 * верить. Судья эвала это и ловил, ставя единицы: факта в контексте нет.
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * Первое: колонки перечислены в запросе. Второе, и оно важнее: НЕТ ДАННЫХ —
 * НЕТ СТРОКИ. `mchs_registration_required = NULL` значит «у нас не записано»,
 * и печатать по нему «не требуется» — выдать незнание за знание (§4.0).
 * Человек прочитает такую строку как разрешение не регистрироваться.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/ai/route-knowledge.ts'), 'utf8');

/** Пустая строка маршрута: все поля неизвестны. */
const NOTHING = {
  difficulty: null, distance_km: null, elevation_gain_m: null,
  duration_hours: null, season: null, hazards: null, equipment: null,
  mchs_registration_required: null, mchs_phone: null, park_name: null,
};

describe('поля §10 выбираются запросом', () => {
  const FIELDS = [
    'mchs_registration_required', 'mchs_phone',
    'distance_km', 'elevation_gain_m', 'duration_hours',
    'difficulty', 'season', 'hazards', 'equipment', 'park_name',
  ];

  it.each(FIELDS)('%s есть в SELECT-списке', (field) => {
    const select = SRC.slice(SRC.indexOf('`SELECT title, description, activity_type'));
    expect(select.slice(0, 600)).toContain(field);
  });

  it('факты печатаются ПЕРЕД описанием', () => {
    // Блок режется по длине с конца: терять он должен пересказ, а не
    // обязательность регистрации.
    expect(SRC).toMatch(/\[head, \.\.\.facts, desc\]/);
  });

  it('потолок блока больше худшего случая, а не круглое число', () => {
    const num = (re: RegExp) => Number(SRC.match(re)![1].replace(/_/g, ''));
    const desc = num(/const DESCRIPTION_CHARS = (\d+)/);
    const block = num(/const ROUTES_BLOCK_CHARS = ([\d_]+)/);
    // Три маршрута: заголовок ~60 + строки фактов ~260 + описание.
    expect(block).toBeGreaterThan(3 * (desc + 320));
  });
});

describe('незнание не выдаётся за «нет»', () => {
  // routeFacts — чистая функция, поэтому проверяется исполнением, а не текстом.
  async function facts(over: Partial<typeof NOTHING>): Promise<string[]> {
    const { routeFacts } = await import('@/lib/ai/route-knowledge');
    return routeFacts({ ...NOTHING, ...over });
  }

  it('всё неизвестно — ни одной строки', async () => {
    expect(await facts({})).toEqual([]);
  });

  it('регистрация NULL — про МЧС не сказано ничего', async () => {
    const lines = await facts({ distance_km: '35' });
    expect(lines.join('\n')).not.toMatch(/МЧС/);
  });

  it('регистрация обязательна — сказано заглавными и с телефоном', async () => {
    const lines = await facts({ mchs_registration_required: true, mchs_phone: '+7 415 000' });
    expect(lines[0]).toContain('ОБЯЗАТЕЛЬНА');
    expect(lines[0]).toContain('+7 415 000');
  });

  it('регистрация не нужна — сказано прямо, но только когда это записано', async () => {
    expect((await facts({ mchs_registration_required: false }))[0])
      .toBe('Регистрация в МЧС: не требуется');
  });

  it('пустые массивы опасностей и снаряжения строк не рождают', async () => {
    expect(await facts({ hazards: [], equipment: [] })).toEqual([]);
  });

  it('известные величины печатаются одной строкой', async () => {
    const lines = await facts({ distance_km: '35', elevation_gain_m: 900, difficulty: 'hard' });
    expect(lines[0]).toBe('дистанция 35 км · набор высоты 900 м · сложность hard');
  });
});

describe('отказ поиска не глушится', () => {
  it('catch пишет причину, а не возвращает пустоту молча', () => {
    // Пустая строка отсюда читается промптом как «маршрутов нет», и молчащий
    // catch делал «не смогли спросить» неотличимым от «в базе пусто».
    expect(SRC).toMatch(/logSwallowedFailure\('kuzmich', 'поиск маршрутов', err\)/);
    expect(SRC).not.toMatch(/\}\s*catch\s*\{\s*return '';\s*\}/);
  });
});
