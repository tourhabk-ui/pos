import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyMchsItem, mchs_zones, fetchMchsFeedXml, ingestMchsAlerts, ingestVkMchs, detectRoadRestriction, titleFingerprint } from '@/lib/services/safety/seismic-parser';

// Реальный бюллетень МЧС Камчатка (2 июля), который раньше молча отбрасывался —
// ни цунами, ни шторм, ни паводок, ни пожар: 4 категории classifyMchsItem не
// покрывали "воздержаться от восхождения на вулкан" вообще.
const MUTNOVSKY_TITLE = 'Камчатским туристам настоятельно рекомендуют воздержаться от восхождения на Мутновский вулкан';
const MUTNOVSKY_DESC = `На Камчатке состоялось внеочередное заседание Камчатского филиала Российского
экспертного совета по прогнозу землетрясений, оценке сейсмической опасности и риска о сейсмической
и вулканической опасности в Камчатском крае. Ученые оценили опасность вулкана Мутновского.
Утром 2 июля был зафиксирован газопепловый выброс. В постройке вулкана происходят многочисленные
землетрясения с магнитудами до 3. В такой активной геодинамической обстановке реальную опасность
при посещении вулкана представляют оползни и обвалы. Спасатели призывают гостей и жителей полуострова
не предпринимать самостоятельных путешествий к вулкану Мутновскому и тем более не совершать на него
восхождений. Руководителям туристических групп также рекомендовано воздержаться от посещения вулкана.`;

describe('classifyMchsItem — volcanic hazard advisories (regression: Mutnovsky 2026-07-02)', () => {
  it('classifies the real Mutnovsky "avoid climbing" bulletin instead of dropping it', () => {
    const event = classifyMchsItem('mchs/test-1', MUTNOVSKY_TITLE, MUTNOVSKY_DESC, '2026-07-02T05:00:00Z', 'https://41.mchs.gov.ru/item/1');
    expect(event).not.toBeNull();
    expect(event!.alert_type).toBe('volcanic_eruption');
  });

  it('assigns severity 2 (drives recommender_status=red) for an explicit avoid-recommendation', () => {
    const event = classifyMchsItem('mchs/test-2', MUTNOVSKY_TITLE, MUTNOVSKY_DESC, '2026-07-02T05:00:00Z', 'https://41.mchs.gov.ru/item/2');
    expect(event!.severity).toBe(2);
  });

  it('resolves the affected zone by volcano name, not just administrative district', () => {
    const event = classifyMchsItem('mchs/test-3', MUTNOVSKY_TITLE, MUTNOVSKY_DESC, '2026-07-02T05:00:00Z', 'https://41.mchs.gov.ru/item/3');
    expect(event!.affected_zones).toEqual(['avachinsky']);
  });

  it('classifies a volcanic-activity bulletin without an explicit avoid-recommendation at lower severity', () => {
    const event = classifyMchsItem(
      'mchs/test-4',
      'Пепловый выброс на вулкане Толбачик',
      'Зафиксирован пепловый выброс на вулкане Толбачик, пеплопад в районе наблюдений.',
      '2026-07-02T05:00:00Z',
      'https://41.mchs.gov.ru/item/4',
    );
    expect(event).not.toBeNull();
    expect(event!.severity).toBe(1);
  });

  it('still returns null for content matching none of the known categories', () => {
    const event = classifyMchsItem('mchs/test-5', 'Открытие нового моста через реку Авача', 'Сегодня состоялось торжественное открытие моста.', '2026-07-02T05:00:00Z', 'https://41.mchs.gov.ru/item/5');
    expect(event).toBeNull();
  });

  it('drops a TV-program teaser mentioning "пожарной" (regression: false fire_danger alert seen live 2026-07-06)', () => {
    const event = classifyMchsItem(
      'mchs/teaser-1',
      'Эксперименты сотрудников испытательной пожарной лаборатории',
      'В новом выпуске программы «МЧС. Экстренный вызов» — эксперименты сотрудников испытательной пожарной лаборатории.',
      '2026-07-06T05:00:00Z',
      'https://41.mchs.gov.ru/item/teaser',
    );
    expect(event).toBeNull();
  });

  it('still classifies the pre-existing categories unchanged (tsunami/flood/fire)', () => {
    const tsunami = classifyMchsItem('mchs/t', 'Угроза цунами', 'Объявлена угроза цунами на побережье.', '2026-07-02T05:00:00Z', 'https://x');
    expect(tsunami!.alert_type).toBe('tsunami_warning');
    expect(tsunami!.severity).toBe(3);

    const flood = classifyMchsItem('mchs/f', 'Паводок на реке Камчатка', 'Ожидается подъём уровня воды на реках.', '2026-07-02T05:00:00Z', 'https://x');
    expect(flood!.alert_type).toBe('flood');

    const fire = classifyMchsItem('mchs/p', 'Особый противопожарный режим', 'Введён особый противопожарный режим.', '2026-07-02T05:00:00Z', 'https://x');
    expect(fire!.alert_type).toBe('fire_danger');
  });
});

describe('classifyMchsItem — шум не становится алертом (скрины владельца 2026-07-17)', () => {
  it('пожарно-тактическое учение → null', () => {
    const e = classifyMchsItem('kamgov/1',
      'Возгорание в гардеробе и эвакуация 10 человек',
      'Пожарно-тактическое учение прошло в новом корпусе средней школы № 40.',
      '2026-07-16T05:00:00Z', 'https://x', 'kamgov');
    expect(e).toBeNull();
  });

  it('новость-итог «по вине курильщиков произошло 4 пожара» → null', () => {
    const e = classifyMchsItem('kamgov/2',
      'По вине неосторожных курильщиков за 2026 год на Камчатке произошло 4 пожара',
      'Статистика пожаров за год.',
      '2026-07-16T05:00:00Z', 'https://x', 'kamgov');
    expect(e).toBeNull();
  });

  it('«полУЧЕНИе пропусков» не считается учением — реальный алерт не отбрасывается', () => {
    const e = classifyMchsItem('kamgov/4',
      'Экстренное предупреждение: высокие классы пожарной опасности',
      'Введён особый противопожарный режим. Получение пропусков в лесные зоны приостановлено.',
      '2026-07-18T05:00:00Z', 'https://x', 'kamgov');
    expect(e).not.toBeNull();
    expect(e!.alert_type).toBe('fire_danger');
  });

  it('«высокие классы пожарной опасности» остаётся fire_danger', () => {
    const e = classifyMchsItem('kamgov/3',
      'Экстренное предупреждение на 16-20 июля 2026 г.',
      'Высокие классы пожарной опасности в лесах края.',
      '2026-07-16T05:00:00Z', 'https://x', 'kamgov');
    expect(e!.alert_type).toBe('fire_danger');
  });

  it('одинаковый заголовок с разными guid → одинаковый source_id (дедуп перепубликаций)', () => {
    const mk = (id: string) => classifyMchsItem(id,
      'Экстренное предупреждение на 16-20 июля 2026 г.',
      'Высокие классы пожарной опасности.',
      '2026-07-16T05:00:00Z', 'https://x', 'kamgov');
    expect(mk('guid-111')!.source_id).toBe(mk('guid-222')!.source_id);
    expect(mk('guid-111')!.source_id).toMatch(/^kamgov\/t/);
  });

  it('оперативная сводка Минтура о доступности туробъектов → info-сводка', () => {
    const e = classifyMchsItem('kamgov/5',
      'Оперативная сводка доступности туристических объектов',
      'Минтур Камчатского края информирует о доступности туристических объектов на 18 июля.',
      '2026-07-18T05:00:00Z', 'https://kamgov.ru/mintur/news/x', 'kamgov');
    expect(e).not.toBeNull();
    expect(e!.alert_type).toBe('info');
    expect(e!.severity).toBe(0);
  });

  it('titleFingerprint нечувствителен к регистру и пунктуации', () => {
    expect(titleFingerprint('Экстренное предупреждение, 16-20 июля!'))
      .toBe(titleFingerprint('экстренное предупреждение 16 20 июля'));
    expect(titleFingerprint('А')).not.toBe(titleFingerprint('Б'));
  });
});

describe('detectRoadRestriction — естественный порядок «глагол→предмет» (сводка ГУ МЧС в ВК/МАХ)', () => {
  it('«Временно ограничено движение транспортных средств» → ограничение (severity 1)', () => {
    // Прямая строка из суточной сводки ГУ МЧС Камчатки (2026-07-21), которую
    // прежний паттерн «предмет→глагол» пропускал: глагол стоит перед предметом.
    const r = detectRoadRestriction(
      'временно ограничено движение транспортных средств на участке автодороги «палана — строящийся аэропорт»',
    );
    expect(r).not.toBeNull();
    expect(r!.severity).toBe(1);
  });

  it('«Перекрыт проезд» → полное перекрытие (severity 2)', () => {
    const r = detectRoadRestriction('перекрыт проезд на участке мыс левашова — октябрьский');
    expect(r).not.toBeNull();
    expect(r!.severity).toBe(2);
  });

  it('обычный текст без дорожных ограничений → null', () => {
    expect(detectRoadRestriction('на реках ожидается подъём уровня воды')).toBeNull();
  });
});

describe('classifyMchsItem — сводка ГУ МЧС из ВК (source vk_mchs, title пустой)', () => {
  it('дорожное ограничение из ВК-поста → road_closure с source_id vk_mchs', () => {
    // У VK-постов нет заголовка: весь текст приходит в description, title=''.
    const e = classifyMchsItem(
      'vk.com/mchs_kamchatka/12345',
      '',
      'Временно ограничено движение транспортных средств на участке автодороги «Палана — строящийся аэропорт».',
      '2026-07-21T06:00:00Z',
      'https://vk.com/wall-123_12345',
      'vk_mchs',
    );
    expect(e).not.toBeNull();
    expect(e!.alert_type).toBe('road_closure');
    expect(e!.source_id).toMatch(/^vk_mchs\/t/);
    expect(e!.source_url).toBe('https://vk.com/wall-123_12345');
  });

  it('подъём воды в реках из ВК-поста → flood', () => {
    const e = classifyMchsItem(
      'vk.com/mchs_kamchatka/12346',
      '',
      'На реках полуострова ожидается подъём уровня воды, возможно подтопление низменных участков.',
      '2026-07-21T06:00:00Z',
      'https://vk.com/wall-123_12346',
      'vk_mchs',
    );
    expect(e).not.toBeNull();
    expect(e!.alert_type).toBe('flood');
  });
});

describe('ingestVkMchs', () => {
  const savedToken = process.env.VK_SERVICE_TOKEN;
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedToken === undefined) delete process.env.VK_SERVICE_TOKEN;
    else process.env.VK_SERVICE_TOKEN = savedToken;
  });

  it('без VK_SERVICE_TOKEN — тихий no-op (опциональный источник, без сети и без ошибок)', async () => {
    delete process.env.VK_SERVICE_TOKEN;
    const fetchSpy = vi.spyOn(global, 'fetch');
    const r = await ingestVkMchs();
    expect(fetchSpy).not.toHaveBeenCalled(); // не ходим в сеть без токена
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it('ошибку VK API кладёт в errors, ничего не вставляет', async () => {
    process.env.VK_SERVICE_TOKEN = 'test-token';
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { error_msg: 'access denied' } }), { status: 200 }),
    );
    const r = await ingestVkMchs();
    expect(r.inserted).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain('access denied');
  });

  it('не-ok HTTP от VK → ошибка, без вставок', async () => {
    process.env.VK_SERVICE_TOKEN = 'test-token';
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const r = await ingestVkMchs();
    expect(r.inserted).toBe(0);
    expect(r.errors[0]).toContain('vk http 500');
  });

  it('пустые/нейтральные посты не порождают событий (классификатор отсеивает шум)', async () => {
    process.env.VK_SERVICE_TOKEN = 'test-token';
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        response: { items: [
          { id: 1, owner_id: -123, date: 1721541600, text: '' },
          { id: 2, owner_id: -123, date: 1721541600, text: 'Поздравляем с профессиональным праздником!' },
        ] },
      }), { status: 200 }),
    );
    const r = await ingestVkMchs();
    expect(r.inserted).toBe(0);
    expect(r.events).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe('mchs_zones', () => {
  it('matches a volcano name before falling back to district regex', () => {
    expect(mchs_zones('опасность вулкана Мутновского')).toEqual(['avachinsky']);
    expect(mchs_zones('вулкан Толбачик, пепловый выброс')).toEqual(['northern']);
    expect(mchs_zones('вулкан Карымский активизировался')).toEqual(['eastern']);
  });

  it('falls back to district-name matching when no volcano is named', () => {
    expect(mchs_zones('паводок в Усть-Камчатском районе')).toEqual(['northern']);
  });

  it('defaults to avachinsky when neither volcano nor known district is mentioned', () => {
    expect(mchs_zones('погодное предупреждение по краю')).toEqual(['avachinsky']);
  });
});

describe('fetchMchsFeedXml (fetches ALL candidate URLs — confirmed live 2026-07-02 that extrenniye-preduprezhdeniya/prognozy/operativnaya-informaciya are distinct sections, not mirrors)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('queries every known candidate URL, not just the first', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('<rss><channel><item><title>ok</title></item></channel></rss>', { status: 200 }),
    );
    await fetchMchsFeedXml();
    expect(fetchSpy).toHaveBeenCalledTimes(5); // все 5 кандидатов, не останавливаемся на первом успешном
  });

  it('collects XML from every candidate that returns valid RSS, not just one', async () => {
    // Response.text() консьюмит тело один раз — каждому concurrent-вызову
    // нужен свой экземпляр Response, иначе конкурирующие .text() читают
    // общий поток и часть вызовов получает пустоту.
    vi.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response('<rss><channel><item><title>ok</title></item></channel></rss>', { status: 200 }),
    );
    const feeds = await fetchMchsFeedXml();
    expect(feeds).toHaveLength(5); // все 5 валидны в этом моке → все 5 в результате
  });

  it('skips a candidate that errors over the network without dropping the others', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('shtormovye')) throw new Error('network down');
      return new Response('<rss><channel><item><title>ok</title></item></channel></rss>', { status: 200 });
    });
    const feeds = await fetchMchsFeedXml();
    expect(feeds).toHaveLength(4); // 5 кандидатов минус 1 упавший
  });

  it('skips a candidate that returns HTTP ok but not RSS (e.g. an HTML error page)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('novosti')) return new Response('<html><body>404 not found</body></html>', { status: 200 });
      return new Response('<rss><channel><item><title>ok</title></item></channel></rss>', { status: 200 });
    });
    const feeds = await fetchMchsFeedXml();
    expect(feeds).toHaveLength(4);
  });

  it('skips a candidate that returns a non-ok HTTP status', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/rss') && !String(url).includes('press-centr')) return new Response('', { status: 404 });
      return new Response('<rss><channel><item><title>ok</title></item></channel></rss>', { status: 200 });
    });
    const feeds = await fetchMchsFeedXml();
    expect(feeds).toHaveLength(4);
  });

  it('returns an empty array when none of the candidates return valid RSS', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    const feeds = await fetchMchsFeedXml();
    expect(feeds).toEqual([]);
  });
});

describe('ingestMchsAlerts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports an error and inserts nothing when no candidate feed is reachable', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    const result = await ingestMchsAlerts();
    expect(result.inserted).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('none of');
  });
});
