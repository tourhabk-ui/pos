import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gradeNameMatch, getGuardianContext } from '@/lib/kuzmich/guardian-context';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('gradeNameMatch (CRAG-lite relevance grading, Roitman §16.5.5)', () => {
  it('grades an exact name match as high confidence', () => {
    expect(gradeNameMatch('Толбачик', 'Толбачик')).toBe('high');
  });

  it('grades case/whitespace-insensitive matches as high confidence', () => {
    expect(gradeNameMatch('толбачик', '  Толбачик  ')).toBe('high');
  });

  it('grades a query fully covered by a longer candidate name as high confidence', () => {
    expect(gradeNameMatch('Авачинский', 'Авачинский вулкан')).toBe('high');
  });

  it('grades a candidate name fully covered by the query as high confidence', () => {
    expect(gradeNameMatch('Мутновский вулкан кратер', 'Мутновский вулкан')).toBe('high');
  });

  it('grades an unrelated short-substring collision as low confidence', () => {
    // ILIKE '%Толбачик%' can bind a short unrelated place containing a shared
    // substring — this must NOT be treated as a confident safety-data match.
    expect(gradeNameMatch('Толбачик', 'Толбачинский дол дальний кордон')).toBe('low');
  });

  it('grades no overlap at all as low confidence', () => {
    expect(gradeNameMatch('Курильское озеро', 'Авачинская бухта')).toBe('low');
  });

  it('grades empty query or candidate as low confidence', () => {
    expect(gradeNameMatch('', 'Толбачик')).toBe('low');
    expect(gradeNameMatch('Толбачик', '')).toBe('low');
  });

  it('does not treat short-word prefixes as a match (e.g. "г" must not match "гора"/"гейзер")', () => {
    expect(gradeNameMatch('г', 'гора')).toBe('low');
    expect(gradeNameMatch('г', 'гейзер')).toBe('low');
  });

  it('a multi-word query with a short word does not become high solely via that word', () => {
    expect(gradeNameMatch('г Ключевская', 'гейзер')).toBe('low');
  });

  it('still grades an exact short word as high confidence', () => {
    expect(gradeNameMatch('юг', 'юг')).toBe('high');
  });

  it('grades Russian morphology (case-ending) variants as low confidence', () => {
    // "Авачинский" (м.р.) vs "Авачинская сопка" (ж.р.) — общий префикс рвётся
    // на последних буквах, это НЕ должно матчиться как high. Это ожидаемо:
    // getGuardianContext компенсирует такие случаи отдельно — surfacing
    // алерта с рамкой неуверенности, а не повышением confidence здесь.
    expect(gradeNameMatch('Авачинский', 'Авачинская сопка')).toBe('low');
  });
});

describe('getGuardianContext low-confidence handling', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockDbFor(placeRow: Record<string, unknown> | null) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: placeRow ? [placeRow] : [] });
      if (sql.includes('FROM external_alerts')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM agent_knowledge')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('surfaces an active alert on a low-confidence match instead of dropping it silently', async () => {
    mockDbFor({
      name: 'Авачинская сопка', description: 'Действующий вулкан', location_type: 'volcano',
      lat: 53.25, lng: 158.83, hazard_types: ['thermal'], difficulty_level: 3, altitude_m: 2741,
      nearest_medical_km: 30, sat_communicator_required: true, capacity_per_day: 100,
      open_from_date: null, open_to_date: null, is_open: true, current_crowds: 5,
      active_alerts: null, recommender_status: 'yellow',
      alert_message: 'Повышенная сейсмическая активность', alert_severity: 2, tourists_today: 10,
    });

    const ctx = await getGuardianContext('Авачинский');

    expect(ctx).toContain('неточное совпадение');
    expect(ctx).toContain('Повышенная сейсмическая активность'); // алерт не потерян
    expect(ctx).not.toContain('2741'); // высота вероятно-не-того места не должна выдаваться как факт
    expect(ctx).not.toContain('30 км'); // расстояние до медпомощи — тоже не факт про запрошенное место
  });

  it('omits the hedge tail entirely when there is no alert for the low-confidence place', async () => {
    mockDbFor({
      name: 'Толбачинский дол дальний кордон', description: 'Кордон', location_type: 'other',
      lat: null, lng: null, hazard_types: null, difficulty_level: null, altitude_m: null,
      nearest_medical_km: null, sat_communicator_required: null, capacity_per_day: null,
      open_from_date: null, open_to_date: null, is_open: null, current_crowds: null,
      active_alerts: null, recommender_status: null, alert_message: null, alert_severity: null,
      tourists_today: null,
    });

    const ctx = await getGuardianContext('Толбачик');

    expect(ctx).toContain('неточное совпадение');
    expect(ctx).not.toContain('алерт');
  });

  it('returns full safety facts unhedged for a high-confidence match', async () => {
    mockDbFor({
      name: 'Толбачик', description: 'Действующий вулкан на Камчатке', location_type: 'volcano',
      lat: 55.83, lng: 160.33, hazard_types: ['thermal'], difficulty_level: 4, altitude_m: 3085,
      nearest_medical_km: 200, sat_communicator_required: true, capacity_per_day: 50,
      open_from_date: null, open_to_date: null, is_open: true, current_crowds: 2,
      active_alerts: null, recommender_status: 'green', alert_message: null, alert_severity: null,
      tourists_today: 3,
    });

    const ctx = await getGuardianContext('Толбачик');

    expect(ctx).not.toContain('неточное совпадение');
    expect(ctx).toContain('3085');
    expect(ctx).toContain('200 км');
  });
});

describe('getGuardianContext — авиационный цветовой код (KVERT, migration 728)', () => {
  beforeEach(() => vi.clearAllMocks());

  const base = {
    name: 'Ключевской', description: 'Вулкан', location_type: 'volcano',
    lat: 56.05, lng: 160.64, hazard_types: null, difficulty_level: null, altitude_m: 4750,
    nearest_medical_km: null, sat_communicator_required: null, capacity_per_day: null,
    open_from_date: null, open_to_date: null, is_open: true, current_crowds: null,
    active_alerts: null, recommender_status: null, alert_message: null, alert_severity: null,
    tourists_today: null,
  };

  function mockDbFor(placeRow: Record<string, unknown>) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: [placeRow] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('красный код с пеплом выдаётся сразу после алертов при точном совпадении', async () => {
    mockDbFor({ ...base, volcano_acc: 'red', volcano_ash_height_m: 8000, volcano_observed_at: '2025-08-07T23:40:00Z' });
    const ctx = await getGuardianContext('Ключевской');
    expect(ctx).toContain('KVERT: КРАСНЫЙ');
    expect(ctx).toContain('Пепел до 8.0 км');
  });

  it('без наблюдённого кода (null/unassigned) — молчим, без ложного «зелёный»', async () => {
    mockDbFor({ ...base, volcano_acc: null, volcano_ash_height_m: null, volcano_observed_at: null });
    expect(await getGuardianContext('Ключевской')).not.toContain('KVERT');
    mockDbFor({ ...base, volcano_acc: 'unassigned', volcano_ash_height_m: null, volcano_observed_at: null });
    expect(await getGuardianContext('Ключевской')).not.toContain('KVERT');
  });

  it('оранжевый/красный код НЕ теряется при слабом совпадении — рамка неуверенности', async () => {
    mockDbFor({
      ...base, name: 'Ключевская группа вулканов дальний сектор',
      volcano_acc: 'orange', volcano_ash_height_m: null, volcano_observed_at: null,
    });
    const ctx = await getGuardianContext('Ключевской');
    expect(ctx).toContain('неточное совпадение');
    expect(ctx).toContain('ОРАНЖЕВЫЙ');
    expect(ctx).toContain('тот ли это вулкан');
  });

  it('жёлтый код при слабом совпадении не добавляет шума (только orange/red)', async () => {
    mockDbFor({
      ...base, name: 'Ключевская группа вулканов дальний сектор',
      volcano_acc: 'yellow', volcano_ash_height_m: null, volcano_observed_at: null,
    });
    const ctx = await getGuardianContext('Ключевской');
    expect(ctx).toContain('неточное совпадение');
    expect(ctx).not.toContain('KVERT');
  });
});

describe('getGuardianContext — чистка контекста (#63, проба 113)', () => {
  beforeEach(() => vi.clearAllMocks());

  const placeBase = {
    description: 'Описание', location_type: 'volcano',
    lat: 53.25, lng: 158.83, hazard_types: ['thermal'], difficulty_level: 3, altitude_m: 2741,
    nearest_medical_km: 30, sat_communicator_required: false, capacity_per_day: 30,
    open_from_date: null, open_to_date: null, is_open: true, current_crowds: 1,
    recommender_status: 'red', alert_message: null, alert_severity: 2, tourists_today: 0,
    volcano_acc: null, volcano_ash_height_m: null, volcano_observed_at: null,
  };

  function mockDb(opts: {
    places?: Record<string, unknown>[];
    alerts?: Record<string, unknown>[];
    knowledge?: Record<string, unknown>[];
  }) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: opts.places ?? [] });
      if (sql.includes('FROM external_alerts')) return Promise.resolve({ rows: opts.alerts ?? [] });
      if (sql.includes('FROM agent_knowledge')) return Promise.resolve({ rows: opts.knowledge ?? [] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('зонный алерт, продублированный в трёх местах, печатается один раз', async () => {
    const shared = ['Вилючинский перевал: проезд по пропускам', 'Риск оползней с Мутновского'];
    mockDb({
      places: [
        { ...placeBase, name: 'Вулкан Авачинский', active_alerts: shared },
        { ...placeBase, name: 'Авачинский перевал', active_alerts: shared },
        { ...placeBase, name: 'Авачинский вулкан: путь на вершину', active_alerts: [...shared, 'Камнепад на верхнем участке'] },
      ],
    });
    const ctx = await getGuardianContext('Авачинский');
    expect(ctx.split('Вилючинский перевал: проезд по пропускам').length - 1).toBe(1);
    expect(ctx.split('Риск оползней с Мутновского').length - 1).toBe(1);
    // Уникальный алерт третьего места не потерян.
    expect(ctx).toContain('Камнепад на верхнем участке');
  });

  it('блок [Алерт КБГС/МЧС] не повторяет алерт, уже показанный в строке места', async () => {
    mockDb({
      places: [{ ...placeBase, name: 'Вулкан Авачинский', active_alerts: ['Пепловый выброс на Авачинском'] }],
      alerts: [
        { title: 'Пепловый выброс на Авачинском', severity: 2, description: 'дубль', source_url: null },
        { title: 'Закрыта тропа на Авачинский', severity: 1, description: null, source_url: null },
      ],
    });
    const ctx = await getGuardianContext('Авачинский');
    expect(ctx.split('Пепловый выброс на Авачинском').length - 1).toBe(1);
    expect(ctx).toContain('[Алерт КБГС/МЧС] Закрыта тропа на Авачинский');
  });

  it('дедуп действует и в hedge-ветке слабого совпадения', async () => {
    const shared = ['Общерегиональный алерт'];
    mockDb({
      places: [
        { ...placeBase, name: 'Вулкан Авачинский', active_alerts: shared },
        { ...placeBase, name: 'Совсем другое место у трассы', active_alerts: shared },
      ],
    });
    const ctx = await getGuardianContext('Авачинский');
    expect(ctx.split('Общерегиональный алерт').length - 1).toBe(1);
  });

  it('запрос знаний исключает служебные оценки ответов (type outcome)', async () => {
    mockDb({ places: [{ ...placeBase, name: 'Вулкан Авачинский', active_alerts: null }] });
    await getGuardianContext('Авачинский');
    const kbCall = mockQuery.mock.calls.find(([sql]) => (sql as string).includes('FROM agent_knowledge'));
    expect(kbCall).toBeDefined();
    expect(kbCall![0]).toMatch(/type <> 'outcome'/);
  });
});

describe('getGuardianContext — запрос «имя тип» находит каноническую точку (issue #1986/#1987)', () => {
  beforeEach(() => vi.clearAllMocks());

  const base = {
    description: null, lat: 52.45, lng: 158.2, hazard_types: null, difficulty_level: null,
    altitude_m: null, nearest_medical_km: null, sat_communicator_required: null,
    capacity_per_day: null, open_from_date: null, open_to_date: null, is_open: true,
    current_crowds: null, active_alerts: null, recommender_status: 'green',
    alert_message: null, alert_severity: null, tourists_today: null,
    volcano_ash_height_m: null, volcano_observed_at: '2026-09-17T00:00:00Z',
  };

  it('запрос попадает в SQL как AND по словам, а не буквальной фразой', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    await getGuardianContext('Мутновский вулкан');
    const placesCall = mockQuery.mock.calls.find(([sql]) => (sql as string).includes('FROM places'));
    expect(placesCall![0]).toContain('p.name ILIKE $1 AND p.name ILIKE $2');
    expect(placesCall![1]).toEqual(['%мутновский%', '%вулкан%']);
  });

  it('среди нескольких совпадений короткое каноническое имя побеждает и несёт KVERT-строку', async () => {
    // Обе записи содержат оба слова запроса («мутновский», «вулкан») — так и
    // было на проде: «Вулкан Мутновский» (14 симв.) и «Скитур на Мутновский
    // вулкан» (28 симв.) обе матчатся при AND-по-словам. Сортировка по
    // длине имени обязана поднять каноническую точку первой.
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) {
        return Promise.resolve({
          rows: [
            { ...base, name: 'Вулкан Мутновский', location_type: 'volcano', volcano_acc: 'green' },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const ctx = await getGuardianContext('Мутновский вулкан');
    expect(ctx).toContain('Вулкан Мутновский (вулкан)');
    expect(ctx).toContain('Авиационный цветовой код KVERT: ЗЕЛЁНЫЙ');
  });
});

describe('getGuardianContext — раздел каталога в заголовке (17.09)', () => {
  // До 17.09 location_type выбирался запросом и не печатался. Два городских
  // холма месяцами носили бейдж «ВУЛКАН» (972-974), а в MCP — единственном
  // канале, которым прод читается из сессии, — тип был невидим: ни заметить,
  // ни проверить починку. Три исхода (§4.0): известный тип → слово; тип
  // записан, но слова нет → сам слаг; типа нет → в заголовке ничего.
  beforeEach(() => vi.clearAllMocks());

  const base = {
    description: null, lat: 53.02, lng: 158.64, hazard_types: null, difficulty_level: null,
    altitude_m: null, nearest_medical_km: null, sat_communicator_required: null,
    capacity_per_day: null, open_from_date: null, open_to_date: null, is_open: true,
    current_crowds: null, active_alerts: null, recommender_status: 'red',
    alert_message: null, alert_severity: null, tourists_today: null,
  };

  function mockDbFor(placeRow: Record<string, unknown>) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.resolve({ rows: [placeRow] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('prints the known type next to the name, before the status', async () => {
    mockDbFor({ ...base, name: 'Сопка Никольская', location_type: 'mountain' });
    const ctx = await getGuardianContext('Сопка Никольская');
    expect(ctx).toContain('Сопка Никольская (гора) [КРАСНЫЙ]');
  });

  it('a volcano is named as such — the very defect 972-974 fixed becomes visible here', async () => {
    mockDbFor({ ...base, name: 'Сопка Никольская', location_type: 'volcano' });
    const ctx = await getGuardianContext('Сопка Никольская');
    expect(ctx).toContain('Сопка Никольская (вулкан)');
  });

  it('prints the raw slug when the type is recorded but has no Russian word', async () => {
    // Примером здесь стоял `glacier`: до 19.09 русского слова для него в
    // словаре не было. Сведение словарей типов дало ему «Ледник», и пример
    // пришлось сменить на заведомо чужой слаг — иначе проверка договора
    // выродилась бы в проверку того, чего в словаре нет.
    mockDbFor({ ...base, name: 'Ледник Козельский', location_type: 'glacier' });
    expect(await getGuardianContext('Ледник Козельский')).toContain('Ледник Козельский (ледник)');

    mockDbFor({ ...base, name: 'Нечто', location_type: 'moraine_field' });
    expect(await getGuardianContext('Нечто')).toContain('Нечто (moraine_field)');
  });

  it('prints nothing about the type when it is NULL — never a default «место»', async () => {
    mockDbFor({ ...base, name: 'Безымянная точка', location_type: null });
    const ctx = await getGuardianContext('Безымянная точка');
    expect(ctx).toContain('Безымянная точка [КРАСНЫЙ]');
    expect(ctx).not.toContain('(место)');
    expect(ctx).not.toContain('Безымянная точка (');
  });
});

describe('getGuardianContext — вторая шкала вулкана, КФ ЕГС (24.09)', () => {
  // Проверено через MCP 24.09: про Мутновский контекст отвечал только
  // «KVERT: ЗЕЛЁНЫЙ — спокоен (наблюдение 17.09)», хотя сводка КФ ЕГС за
  // 22.09 держала его жёлтым (сейсмичность выше фона, 255 событий). Радар
  // уже знал обе шкалы (#1998), Кузьмич и MCP — нет.
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  const row = {
    name: 'Вулкан Мутновский', description: null, location_type: 'volcano', lat: 52.45, lng: 158.2,
    hazard_types: ['thermal'], difficulty_level: null, altitude_m: null, nearest_medical_km: null,
    sat_communicator_required: null, capacity_per_day: null, open_from_date: null, open_to_date: null,
    is_open: null, current_crowds: null, active_alerts: null, recommender_status: null,
    alert_message: null, alert_severity: null, tourists_today: null,
    volcano_acc: 'green', volcano_ash_height_m: null, volcano_observed_at: '2026-09-17T00:00:00Z',
    kfegs_color: 'yellow', kfegs_raw: 'Желтый',
    kfegs_seismicity: 'R=3.2; Ks пред.=4.0 Выше фона. Количество событий в районе вулкана 255.',
    kfegs_date: '2026-09-22',
  };

  function mockPlace(r: Record<string, unknown>) {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve({ rows: sql.includes('FROM places') ? [r] : [] }));
  }

  it('жёлтый КФ ЕГС виден рядом с зелёным KVERT, со смыслом шкалы', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T03:00:00Z'));
    mockPlace(row);
    const ctx = await getGuardianContext('Мутновский вулкан');
    expect(ctx).toContain('KVERT: ЗЕЛЁНЫЙ');
    expect(ctx).toContain('КФ ЕГС (сейсмичность, за 22.09): жёлтый');
    expect(ctx).toContain('255');
    expect(ctx).toContain('не авиационный код');
    // Прод 24.09: «событий 255.. Это» — точка источника плюс своя.
    expect(ctx).not.toMatch(/\.\./);
  });

  it('устаревшая сводка названа устаревшей, её цвет за текущий не выдаётся', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T03:00:00Z'));
    mockPlace(row);
    const ctx = await getGuardianContext('Мутновский вулкан');
    expect(ctx).toContain('Сводка КФ ЕГС по вулкану устарела (последняя за 22.09)');
    expect(ctx).not.toContain('жёлтый');
  });

  it('вулкан сводкой не охвачен — строки нет, без ложного «зелёный»', async () => {
    mockPlace({ ...row, kfegs_color: null, kfegs_raw: null, kfegs_seismicity: null, kfegs_date: null });
    expect(await getGuardianContext('Мутновский вулкан')).not.toContain('КФ ЕГС');
  });

  it('зелёный КФ ЕГС — без пояснения про повышенную сейсмичность', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T03:00:00Z'));
    mockPlace({ ...row, kfegs_color: 'green', kfegs_raw: 'Зеленый', kfegs_seismicity: null });
    const ctx = await getGuardianContext('Мутновский вулкан');
    expect(ctx).toContain('КФ ЕГС (сейсмичность, за 22.09): зелёный');
    expect(ctx).not.toContain('повышенная сейсмичность');
  });

  it('оранжевый КФ ЕГС не теряется при слабом совпадении имени', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T03:00:00Z'));
    mockPlace({ ...row, name: 'Мутновская ГеоЭС дальний участок', volcano_acc: null, kfegs_color: 'orange' });
    const ctx = await getGuardianContext('Мутновский вулкан');
    expect(ctx).toContain('неточное совпадение');
    expect(ctx).toContain('уровень КФ ЕГС оранжевый');
  });

  it('запрос берёт ПОСЛЕДНЮЮ строку сводки по месту', async () => {
    mockPlace(row);
    await getGuardianContext('Мутновский вулкан');
    const sql = mockQuery.mock.calls.find(([s]) => (s as string).includes('FROM places'))![0] as string;
    expect(sql).toMatch(/FROM volcano_bulletin_kfegs b\s+WHERE b\.place_ark_id = p\.ark_id\s+ORDER BY b\.observed_date DESC\s+LIMIT 1/);
  });
});
