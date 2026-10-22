/**
 * Тревога в контексте места — по тому, где в ней названо место (#2699).
 *
 * Дайджест 22.10: у Шивелуча стояло «[Предупреждение, источник: МЧС России по
 * Камчатскому краю (VK)] Остаётся закрытым проезд … в Усть-Большерецком
 * округе: За прошедшие сутки … горел мусор … Погибш…». Сводка МЧС целиком
 * лежит одной тревогой, Шивелуч назван в ней дальше, а строка печатала
 * чужой заголовок и первые 150 знаков, обрывая слово.
 *
 * Проверка — вызовом getGuardianContext на подставной базе и вызовом
 * функций строки на граничных текстах.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { alertLineForPlace, clipAtWord, ALERT_SNIPPET_MAX } from '@/lib/kuzmich/alert-mention';
import { getGuardianContext } from '@/lib/kuzmich/guardian-context';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

/** Сводка МЧС из ВК так, как она лежит в external_alerts: заголовок — первая тема, описание — вся сводка. */
const MCHS_SUMMARY = {
  title: 'Остаётся закрытым проезд для всех видов транспорта на участке автодороги в Усть-Большерецком округе',
  description: [
    'За прошедшие сутки к тушению техногенных пожаров сотрудники МЧС России привлекались 2 раза. '
      + 'В обоих случаях горел мусор на открытой территории. Погибших и пострадавших нет.',
    '🌋 Вулкан Шивелуч продолжает извергаться: выброс пепла до 12 км, авиационный код оранжевый. '
      + 'Туристам не приближаться к вершине ближе 10 км.',
    'В Елизовском районе ожидается ветер до 25 м/с.',
  ].join('\n'),
  severity: 2,
  source_url: 'https://vk.com/mchs_kamchatka',
  external_id: 'mchs-vk-1',
};

describe('alertLineForPlace', () => {
  it('место только в теле сводки — фрагмент о нём, без чужого заголовка и начала сводки', () => {
    const line = alertLineForPlace(MCHS_SUMMARY, 'Шивелуч', 'МЧС России по Камчатскому краю (VK)');
    expect(line).not.toBeNull();
    expect(line).toMatch(/^\[Упоминание в сводке, источник: МЧС России по Камчатскому краю \(VK\)\] /);
    expect(line).toContain('Вулкан Шивелуч продолжает извергаться');
    expect(line).not.toContain('Усть-Большерецк');
    expect(line).not.toContain('мусор');
    expect(line).not.toContain('Погибш');
    expect(line).not.toContain('Предупреждение');
  });

  it('место в заголовке — тревога о нём: заголовок и начало описания, обрезка по слову', () => {
    const line = alertLineForPlace(
      { title: 'Вулкан Шивелуч: не ближе 10 км к вершине', description: MCHS_SUMMARY.description },
      'шивелуч',
      'KVERT',
    );
    expect(line).toMatch(/^\[Предупреждение, источник: KVERT\] Вулкан Шивелуч: не ближе 10 км к вершине: /);
    expect(line).toMatch(/…$/);
    // Обрезано между словами, а не посреди слова «Погибших».
    expect(line).not.toMatch(/Погибш…/);
  });

  it('место в первом пункте описания — тема та же: заголовок тревоги и текст рядом с названием', () => {
    const line = alertLineForPlace(
      { title: 'Землетрясение M5.1', description: 'Магнитуда 5.1, глубина 10 км. Эпицентр в 20 км от вулкана Мутновский.' },
      'Мутновский',
      'КБГС РАН',
    );
    expect(line).toBe('[Предупреждение, источник: КБГС РАН] Землетрясение M5.1: Магнитуда 5.1, глубина 10 км. Эпицентр в 20 км от вулкана Мутновский.');
  });

  it('ё и регистр не мешают найти место в сводке', () => {
    const line = alertLineForPlace(
      { title: 'Сводка за сутки', description: 'Пожаров нет.\nНа озере Курильском замечен медвёжий выводок у тропы.' },
      'курильском',
      'МЧС',
    );
    expect(line).toContain('На озере Курильском замечен медвёжий выводок у тропы.');
  });

  it('место не названо ни в заголовке, ни в описании — строки нет', () => {
    expect(alertLineForPlace({ title: 'Ветер в Елизово', description: 'До 25 м/с.' }, 'Шивелуч', 'МЧС')).toBeNull();
    expect(alertLineForPlace({ title: 'Ветер', description: null }, 'Шивелуч', 'МЧС')).toBeNull();
  });
});

describe('clipAtWord', () => {
  it('короткий текст — как есть, без многоточия', () => {
    expect(clipAtWord('Закрыта тропа.')).toBe('Закрыта тропа.');
  });

  it('длинный — не длиннее предела, по границе слова, с многоточием', () => {
    const long = `${'слово '.repeat(40)}конец`;
    const out = clipAtWord(long);
    expect(out.length).toBeLessThanOrEqual(ALERT_SNIPPET_MAX);
    expect(out).toMatch(/слово…$/);
  });

  it('предел приходится на середину слова — слово отброшено целиком, а не обрублено («Погибш…»)', () => {
    const text = `${'х'.repeat(143)} Погибших и пострадавших нет`;
    expect(clipAtWord(text)).toBe(`${'х'.repeat(143)}…`);
  });

  it('место дальше окна — окно сдвинуто к нему, название целиком, многоточия с обеих сторон', () => {
    const text = `${'длинное вступление сводки '.repeat(10)}вулкан Шивелуч выбросил пепел до 12 км ${'и ещё хвост '.repeat(10)}`;
    const index = text.indexOf('Шивелуч');
    const out = clipAtWord(text, ALERT_SNIPPET_MAX, { index, length: 'Шивелуч'.length });
    expect(out.length).toBeLessThanOrEqual(ALERT_SNIPPET_MAX);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toContain('Шивелуч выбросил пепел');
  });
});

describe('getGuardianContext — сводка о другом районе у места (#2699)', () => {
  beforeEach(() => vi.clearAllMocks());

  const shiveluch = {
    id: '1', is_visible: true, name: 'Шивелуч', description: null, location_type: 'volcano',
    lat: 56.63661, lng: 161.31221, hazard_types: ['volcanic'], difficulty_level: 4, altitude_m: 3283,
    nearest_medical_km: 45, sat_communicator_required: true, capacity_per_day: null,
    open_from_date: null, open_to_date: null, is_open: true, current_crowds: 0,
    recommender_status: 'red', alert_message: null, alert_severity: 3, tourists_today: null,
    active_alerts: ['Вулкан Шивелуч: не ближе 10 км к вершине'],
    volcano_acc: null, volcano_ash_height_m: null, volcano_observed_at: null,
  };

  function mockDb(alerts: Record<string, unknown>[]) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: [shiveluch] });
      if (sql.includes('FROM external_alerts')) return Promise.resolve({ rows: alerts });
      return Promise.resolve({ rows: [] });
    });
  }

  it('карточка Шивелуча не несёт ни Усть-Большерецкого округа, ни обрывка о погибших', async () => {
    mockDb([MCHS_SUMMARY]);
    const ctx = await getGuardianContext('Шивелуч');
    expect(ctx).not.toContain('Усть-Большерецк');
    expect(ctx).not.toContain('Погибш');
    expect(ctx).toContain('[Упоминание в сводке, источник:');
    expect(ctx).toContain('Вулкан Шивелуч продолжает извергаться');
  });

  it('тревоги, названные по месту, запрашиваются раньше упоминаний в чужих сводках', async () => {
    mockDb([]);
    await getGuardianContext('Шивелуч');
    const alertsSql = mockQuery.mock.calls.map((c) => String(c[0])).find((s) => s.includes('FROM external_alerts'));
    expect(alertsSql).toMatch(/ORDER BY \(title ILIKE \$1\) DESC, severity DESC/);
  });
});
