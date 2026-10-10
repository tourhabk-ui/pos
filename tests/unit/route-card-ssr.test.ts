// @vitest-environment node
/**
 * Карточка маршрута — с сервера целиком (SEO, 10.10; аудит 29.09, Н1).
 *
 * До этого поисковик получал в первом HTML только заголовок, описание и точки
 * (сводку); статы, опасности, подготовка, туры и карта собирались в браузере
 * запросом к /api/routes/[id]. Сборка вынесена в lib/routes/route-detail и
 * зовётся из двух мест — API и серверного рендера страницы, — с двумя флагами:
 *   - explain: модель зовётся только по нажатию человека, рендер — никогда;
 *   - countView: просмотр засчитывает запрос из браузера, а не рендер, куда
 *     ходят и поисковики.
 * Не собралась на сервере — карточка грузится из браузера, как раньше, а
 * причина в логе (§4.0). Обновление из браузера карточку, пришедшую с
 * сервера, не прячет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LIB = code(read('lib/routes/route-detail.ts'));
const API = code(read('app/api/routes/[id]/route.ts'));
const PAGE = code(read('app/routes/[id]/page.tsx'));
const CLIENT = code(read('app/routes/[id]/_RouteDetailClient.tsx'));

describe('одна сборка карточки на API и страницу', () => {
  it('API только зовёт сборку и засчитывает просмотр', () => {
    expect(API).toMatch(/loadRouteDetail\(id, \{ explain: wantExplain, countView: true \}\)/);
    expect(API).not.toMatch(/FROM agent_route_knowledge/);
  });

  it('просмотр считается только по флагу', () => {
    expect(LIB).toMatch(/if \(opts\.countView\) \{\s*pool\.query\('UPDATE kamchatka_routes SET view_count/);
    expect(LIB.match(/view_count = view_count \+ 1/g)).toHaveLength(1);
  });

  it('страница собирает карточку на сервере: без модели и без счётчика', () => {
    expect(PAGE).toMatch(/loadRouteDetail\(route\.id, \{ explain: false, countView: false \}\)/);
    expect(PAGE).toMatch(/initialRoute=\{initialRoute\}/);
    // Через JSON — та же форма, что отдаёт API.
    expect(PAGE).toMatch(/JSON\.parse\(JSON\.stringify\(detail\.data\)\)/);
  });

  it('отказ сборки на сервере не роняет страницу и не молчит', () => {
    expect(PAGE).toMatch(/catch \(err\) \{\s*logQueryFailure\('route_detail_ssr', err, route\.id\);\s*\}/);
  });
});

describe('клиент показывает карточку с сервера сразу', () => {
  it('состояние начинается с неё, скелета нет', () => {
    expect(CLIENT).toMatch(/useState<RouteDetail \| null>\(initialRoute\)/);
    expect(CLIENT).toMatch(/const \[loading, setLoading\] = useState\(!initialRoute\)/);
  });

  it('отказ обновления из браузера не превращает карточку в «не найден»', () => {
    expect(CLIENT).toMatch(/\} else if \(!initialRoute\) \{\s*setNotFound\(true\);/);
    expect(CLIENT).toMatch(/\.catch\(\(\) => \{\s*if \(initialRoute\) return;/);
  });

  it('даты — с явным поясом: сервер и браузер рисуют одно и то же', () => {
    const calls = CLIENT.match(/toLocaleDateString\('ru-RU', \{[^}]*\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, c).toMatch(/timeZone: '(UTC|Asia\/Kamchatka)'/);
  });
});
