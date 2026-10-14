/**
 * Кузьмич видит факты маршрутов места (14.10, владелец: «Кузьмич деградирует»).
 *
 * Недельная оценка: pass_rate фикстуры 0.80 (21.09) → 0.65 (05.10, 12.10),
 * вопросы о безопасности 7 из 8 → 3 из 8. Проваливались одним способом:
 * сложность, набор высоты, высоту, регистрацию в МЧС, расстояние до медпомощи
 * Кузьмич называл без опоры в данных хода. Данные при этом были: у маршрута
 * «Вулкан Корякский» — сложность extreme, 8.4 км, набор 2544 м, в описании
 * 10–12 часов, лёд, кошки и ледоруб. Инструмент места знал о маршрутах только
 * название и длину.
 *
 * Сторож — вызов get_guardian_context на подменённой базе: что увидит модель.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getGuardianContext, routeFactsLines, unrecordedSafetyLine, ROUTE_FACTS_MAX,
  type RouteFactsSource,
} from '@/lib/kuzmich/guardian-context';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const SOPKA_ID = '7a1f0c2e-0000-4000-8000-000000000001';
const sopka = {
  id: SOPKA_ID, is_visible: true, name: 'Корякская сопка', location_type: 'volcano',
  lat: 53.32047, lng: 158.71157, recommender_status: 'green', description: null,
  altitude_m: null, nearest_medical_km: null, hazard_types: [], profile_source: 'type_template',
};

const koryakRoute: RouteFactsSource = {
  id: 'r-koryak', title: 'Вулкан Корякский', difficulty: 'extreme', distance_km: '8.4',
  elevation_gain_m: 2544, duration_hours: null, season: null, hazards: null, equipment: null,
  mchs_registration_required: false, mchs_phone: null, park_name: null,
  description: 'Корякский (3456 м) — действующий стратовулкан. Восхождение сложнее Авачинского: 10–12 часов, на финальном участке — ледовые поля, требуются кошки и ледоруб.',
};

interface Db {
  places?: unknown[];
  through?: unknown[] | Error;
  named?: unknown[] | Error;
}

/** Подмена базы по тексту запроса: места, маршруты через место, маршруты по названию. */
function db({ places = [sopka], through = [], named = [] }: Db) {
  mockQuery.mockImplementation((sql: string) => {
    const reply = (v: unknown[] | Error) => (v instanceof Error ? Promise.reject(v) : Promise.resolve({ rows: v }));
    if (sql.includes('FROM route_waypoints')) return reply(through);
    if (sql.includes('FROM kamchatka_routes kr')) return reply(named);
    if (sql.includes('FROM places')) return reply(places);
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => vi.clearAllMocks());

describe('факты маршрута доходят до модели', () => {
  it('«Корякский вулкан»: маршрут по названию — сложность, набор, описание с кошками и ледорубом', async () => {
    db({ named: [koryakRoute] });
    const ctx = await getGuardianContext('Корякский вулкан');
    expect(ctx).toContain('Маршруты каталога к этому месту — данные из базы Ведара:');
    expect(ctx).toContain('«Вулкан Корякский»: дистанция 8.4 км · набор высоты 2544 м · сложность extreme');
    expect(ctx).toContain('кошки и ледоруб');
    expect(ctx).toContain('3456 м');
  });

  it('регистрация false — не «не требуется»: сказано, что в базе не записана (дефолт колонки, 933)', async () => {
    db({ named: [koryakRoute] });
    const ctx = await getGuardianContext('Корякский вулкан');
    expect(ctx).not.toMatch(/не требуется/);
    expect(ctx).toContain('Регистрация в МЧС по этим маршрутам в базе не записана — это не значит, что она не нужна.');
  });

  it('регистрация true — «ОБЯЗАТЕЛЬНА» с телефоном, и строки «не записана» нет', async () => {
    db({ named: [{ ...koryakRoute, id: 'r-nal', title: 'Налычевское кольцо', mchs_registration_required: true, mchs_phone: '+7 4152 41-12-60' }] });
    const ctx = await getGuardianContext('Налычево');
    expect(ctx).toContain('«Налычевское кольцо»: Регистрация в МЧС: ОБЯЗАТЕЛЬНА, телефон +7 4152 41-12-60');
    expect(ctx).not.toContain('в базе не записана');
  });

  it('маршрут через место тоже даёт факты — и на MCP, где ссылок нет', async () => {
    db({ through: [{ id: 'r-way', slug: 'koryak-way', title: 'Восхождение на Корякскую сопку', distance_km: '11.5', difficulty: 'hard', link_kind: 'waypoint', elevation_gain_m: 1463 }] });
    const mcp = await getGuardianContext('Корякская сопка');
    expect(mcp).toContain('«Восхождение на Корякскую сопку»: дистанция 11.5 км · набор высоты 1463 м · сложность hard');
    expect(mcp).not.toContain('Маршруты через это место на сайте');
    const chat = await getGuardianContext('Корякская сопка', { pageLinks: true });
    expect(chat).toContain('Маршруты через это место на сайте');
    expect(chat).toContain('набор высоты 1463 м');
  });

  it('«рядом» (link_kind nearby) фактами не раскрывается: через место такой маршрут не идёт (§4.1)', async () => {
    db({ through: [{ id: 'r-near', slug: 'near', title: 'Авачинский перевал', distance_km: '5', link_kind: 'nearby', elevation_gain_m: 300 }] });
    const ctx = await getGuardianContext('Корякская сопка');
    expect(ctx).not.toContain('«Авачинский перевал»:');
    expect(ctx).not.toContain('Маршруты каталога к этому месту');
  });

  it('один маршрут найден и по названию, и через место — назван один раз', async () => {
    const same = { ...koryakRoute, slug: 'vulkan-koryakskiy', link_kind: 'waypoint' };
    db({ named: [koryakRoute], through: [same] });
    const ctx = await getGuardianContext('Корякский вулкан');
    expect(ctx.split('«Вулкан Корякский»:').length - 1).toBe(1);
  });

  it('сырой JSON модели вместо описания не цитируется (санитар его ещё не убрал)', async () => {
    const garbage = '```json\n[\n  {\n    "probability": 0.4,\n    "text": "Восхождение на Корякскую сопку"\n  }\n]';
    db({ named: [{ ...koryakRoute, description: garbage }] });
    const ctx = await getGuardianContext('Корякский вулкан');
    expect(ctx).not.toContain('probability');
    expect(ctx).toContain('набор высоты 2544 м');
  });

  it('места нет, а маршрут по названию есть — факты отданы, а не «ничего не найдено»', async () => {
    db({ places: [], named: [{ ...koryakRoute, id: 'r-ring', title: 'Налычевское кольцо' }] });
    const ctx = await getGuardianContext('Налычевское кольцо');
    expect(ctx).toContain('в справочнике не нашлось');
    expect(ctx).toContain('«Налычевское кольцо»: дистанция 8.4 км');
  });

  it('база отказала на маршрутах по названию — «проверить не удалось», а не тишина', async () => {
    db({ named: new Error('57014 canceling statement') });
    const ctx = await getGuardianContext('Корякский вулкан');
    expect(ctx).toContain('Маршруты к этому месту проверить не удалось — не говори, что их нет.');
    expect(ctx).toContain('Корякская сопка');
  });

  it('запрос из одних общих слов («вулкан») маршруты наугад не подбирает', async () => {
    db({ named: [koryakRoute] });
    await getGuardianContext('вулкан');
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('FROM kamchatka_routes kr'))).toBe(false);
  });

  it('маршрутов не больше ROUTE_FACTS_MAX', () => {
    const many = Array.from({ length: ROUTE_FACTS_MAX + 3 }, (_, i) => ({ ...koryakRoute, id: `r${i}`, title: `Маршрут ${i}` }));
    const lines = routeFactsLines(many);
    expect(lines.filter((l) => l.startsWith('«')).length).toBe(ROUTE_FACTS_MAX);
  });
});

describe('пробел в числах безопасности назван, а не заполнен памятью', () => {
  it('вулкан без высоты и без расстояния до медпомощи — названы оба', async () => {
    db({});
    const ctx = await getGuardianContext('Корякская сопка');
    expect(ctx).toContain('В базе не записаны: высота, расстояние до медпомощи. Если спросят — по памяти числом не называй');
  });

  it('у озера высота не нужна — назван только пробел медпомощи', () => {
    expect(unrecordedSafetyLine({ location_type: 'lake', altitude_m: null, nearest_medical_km: null }))
      .toBe('В базе не записаны: расстояние до медпомощи. Если спросят — по памяти числом не называй, скажи, что у Ведара этих цифр нет (число из данных ниже назвать можно).');
  });

  it('всё записано — строки нет; записанное печатается числом', async () => {
    expect(unrecordedSafetyLine({ location_type: 'volcano', altitude_m: 3456, nearest_medical_km: 25 })).toBeNull();
    db({ places: [{ ...sopka, altitude_m: 3456, nearest_medical_km: 25 }] });
    const ctx = await getGuardianContext('Корякская сопка');
    expect(ctx).toContain('Высота 3456 м.');
    expect(ctx).toContain('До медпомощи: 25 км.');
    expect(ctx).not.toContain('В базе не записаны');
  });

  it('высота известна, опасностей нет — об опасностях всё равно сказано, что не размечены', async () => {
    db({ places: [{ ...sopka, altitude_m: 3456 }] });
    const ctx = await getGuardianContext('Корякская сопка');
    expect(ctx).toContain('Опасности этого места в базе не размечены — это не значит, что их нет.');
  });
});
