/**
 * Вечерняя сверка SEO 29.09: внешний аудит против кода и живой пробы с
 * раннера. Каждый блок называет, что было на проде и почему это дефект.
 *
 * Заголовки проверяются ПОВЕДЕНИЕМ, а не видом строки: сопоставление путей
 * повторяет рантайм Next (server/lib/router-utils/filesystem.js,
 * buildCustomRoute: getPathMatch со strict, removeUnnamedParams и
 * modifyRouteRegex). Сторож Н13 утреннего аудита смотрел только meta и
 * robots.ts и зеленел, пока заголовок закрывал страницу, — держал половину
 * связки (§10.09).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const req = createRequire(join(ROOT, 'package.json'));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
type Matcher = (path: string) => false | Record<string, unknown>;

const { getPathMatch } = req('next/dist/shared/lib/router/utils/path-match') as {
  getPathMatch: (source: string, opts: Record<string, unknown>) => Matcher;
};
const { modifyRouteRegex } = req('next/dist/lib/redirect-status') as {
  modifyRouteRegex: (regex: string, restricted?: string[]) => string;
};

async function loadRules(): Promise<{ rule: HeaderRule; match: Matcher }[]> {
  const cfg = req(join(ROOT, 'next.config.js')) as { headers: () => Promise<HeaderRule[]> };
  const rules = await cfg.headers();
  return rules.map((rule) => ({
    rule,
    match: getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (r: string) => modifyRouteRegex(r),
    }),
  }));
}

/** Действующее значение заголовка: из совпавших записей побеждает последняя. */
async function effective(path: string, key: string): Promise<string | null> {
  let value: string | null = null;
  for (const { rule, match } of await loadRules()) {
    if (match(path) === false) continue;
    for (const h of rule.headers) if (h.key.toLowerCase() === key.toLowerCase()) value = h.value;
  }
  return value;
}

describe('посадочная «Рыбалка» не закрыта заголовком', () => {
  it('/hub/fishing без X-Robots-Tag noindex — meta «index» больше не спорит с заголовком', async () => {
    expect(await effective('/hub/fishing', 'X-Robots-Tag')).toBeNull();
  });

  it('остальной кабинет закрыт, в том числе адреса, похожие на рыбалку', async () => {
    for (const p of ['/hub', '/hub/safety', '/hub/admin', '/hub/admin/finance', '/hub/operator', '/hub/fishingx', '/hub/fishing-drafts']) {
      expect(await effective(p, 'X-Robots-Tag'), p).toMatch(/noindex/);
    }
  });

  it('ни один статический адрес sitemap не получает noindex заголовком', async () => {
    const src = read('lib/seo/sitemap-entries.ts');
    const paths = [...src.matchAll(/`\$\{BASE\}(\/[^`$]*)`/g)].map((m) => m[1]);
    expect(paths).toContain('/hub/fishing');
    expect(paths.length).toBeGreaterThan(30);
    for (const p of paths) {
      expect(await effective(p, 'X-Robots-Tag'), p).toBeNull();
    }
  });
});

describe('машинные файлы отдаются со своим Cache-Control', () => {
  it('sitemap, robots, llms.txt и ленты не попадают под общий no-store', async () => {
    for (const p of ['/sitemap.xml', '/robots.txt', '/llms.txt', '/api/channels/avito/feed', '/api/channels/yandex/feed']) {
      expect(await effective(p, 'Cache-Control'), p).toBeNull();
    }
  });

  it('обещанный ими кэш объявлен в самих роутах', () => {
    expect(code('app/sitemap.xml/route.ts')).toMatch(/'Cache-Control':\s*'public,[^']*s-maxage=3600/);
    expect(code('app/llms.txt/route.ts')).toMatch(/'Cache-Control':\s*'public,/);
  });

  it('HTML по-прежнему no-store — статус дня и личные данные не из кэша прокси', async () => {
    for (const p of ['/', '/places/vulkan-gorelyj', '/catalog/tours/6', '/hub/fishing', '/sitemap.xml.bak', '/api/places/x']) {
      expect(await effective(p, 'Cache-Control'), p).toMatch(/no-store/);
    }
  });
});

describe('/routes и /places — разные страницы с разными заголовками', () => {
  const titleOf = (p: string) => code(p).match(/export const metadata[\s\S]*?title:\s*'([^']+)'/)?.[1] ?? '';

  it('title /routes говорит «маршруты» и не совпадает с /places', () => {
    const routes = titleOf('app/routes/(list)/page.tsx');
    const places = titleOf('app/places/page.tsx');
    expect(routes).toMatch(/^Маршруты/);
    expect(places).toMatch(/^Места/);
    expect(routes).not.toBe(places);
  });

  it('H1 каталога называет раздел, а не одно слово «Камчатка»', () => {
    const client = code('app/routes/_RoutesPageClient.tsx');
    expect(client).not.toMatch(/<h1[^>]*>\s*Камчатка\s*<\/h1>/);
    expect(client).toMatch(/heading: 'Маршруты по Камчатке'/);
    expect(client).toMatch(/heading: 'Места Камчатки'/);
    expect(client).toMatch(/<h1[^>]*>\{KIND_TABS\.find\(t => t\.value === kind\)\?\.heading/);
  });
});

describe('главная, каталог и рыбалка называют спрос', () => {
  it('title главной называет туры, описание — без цифр, рублей, года и непроверенных обещаний', () => {
    const src = code('app/page.tsx');
    const title = src.match(/const HOME_TITLE = '([^']+)'/)?.[1] ?? '';
    const desc = src.match(/const HOME_DESCRIPTION = '([^']+)'/)?.[1] ?? '';
    expect(title).toMatch(/^Туры и маршруты по Камчатке/);
    expect(title).toMatch(/Ведар/);
    expect(desc).toMatch(/Туры на Камчатку/);
    expect(desc.length).toBeGreaterThan(110);
    for (const s of [title, desc]) {
      expect(s).not.toMatch(/\d|₽|руб/);
      expect(s).not.toMatch(/проверенн|регистрац/i);
    }
  });

  it('точную фразу «Туры на Камчатку» в начале title держат каталог и планы, а не главная', () => {
    expect(code('app/catalog/(list)/page.tsx')).toMatch(/title: 'Туры на Камчатку/);
    expect(code('app/plans/page.tsx')).toMatch(/title: 'Туры на Камчатку/);
    expect(code('app/page.tsx')).not.toMatch(/HOME_TITLE = 'Туры на Камчатку/);
  });

  it('og и twitter главной совпадают с title и description', () => {
    const src = code('app/page.tsx');
    expect(src).toMatch(/title: HOME_TITLE,\s*description: HOME_DESCRIPTION,\s*openGraph:/);
    expect(src).toMatch(/openGraph: \{[\s\S]*?title: HOME_TITLE,\s*description: HOME_DESCRIPTION,/);
    expect(src).toMatch(/twitter: \{[^}]*title: HOME_TITLE, description: HOME_DESCRIPTION/);
  });

  it('H1 героя главной не тронут — решение владельца 14.08', () => {
    expect(code('components/homepage/HeroStatus.tsx')).toMatch(/Соберите безопасную поездку на Камчатку/);
  });

  it('H1 и title каталога туров — «Туры на Камчатку»', () => {
    expect(code('components/marketplace/MarketplaceClient.tsx')).toMatch(/<h1[\s\S]{0,200}>\s*Туры на Камчатку\s*<\/h1>/);
    expect(code('app/catalog/(list)/page.tsx')).toMatch(/title: 'Туры на Камчатку/);
  });

  it('/hub/fishing: H1 совпадает с запросом, у ссылки есть картинка', () => {
    expect(code('app/hub/fishing/_FishingPageClient.tsx')).toMatch(/<h1[^>]*>\s*Рыбалка на Камчатке\s*<\/h1>/);
    const page = code('app/hub/fishing/page.tsx');
    expect(page).toMatch(/openGraph:[\s\S]*?images: \[\{ url: '\/images\/activities\/fishing\.jpg'/);
    expect(read('public/images/activities/fishing.jpg').length).toBeGreaterThan(10_000);
  });
});

describe('/hub/fishing открыта индексу — на ней нет обещаний без источника', () => {
  const client = code('app/hub/fishing/_FishingPageClient.tsx');
  const page = code('app/hub/fishing/page.tsx');

  it('туры — по настоящему адресу /catalog/tours/{id}, в разметке и в карточках', () => {
    expect(page).not.toMatch(/hub\/marketplace/);
    expect((page.match(/\$\{SITE\}\/catalog\/tours\/\$\{t\.id\}/g) ?? []).length).toBe(3);
    expect(client).toMatch(/href=\{`\/catalog\/tours\/\$\{tour\.id\}`\}/);
    expect(client).not.toMatch(/\/marketplace\/tours/);
  });

  it('нет номера без источника, стажа, года основания, «всё включено» и «дни × 4 человека»', () => {
    for (const bad of [/264444/, /10\+ лет/, /2010/, /Всё включено/, /моторных лод/, /maxDays \* 4/]) {
      expect(client, String(bad)).not.toMatch(bad);
    }
  });

  it('сводка считается из строк туров и не выводится при пустом списке', () => {
    expect(client).toMatch(/const minPrice\s+= hasTours \?/);
    expect(client).toMatch(/\{minPrice !== null && \(/);
    expect(client).toMatch(/\{hasTours && \(/);
  });
});

describe('ссылки на маршрут — в пространстве id карточки', () => {
  // /routes/[id] ищет маршрут по UUID как COALESCE(ark_id, id) (VIEW
  // agent_route_knowledge). Голый kr.id у записи с ark_id там не находится.
  it('sitemap отдаёт id маршрута из пространства VIEW', () => {
    expect(code('lib/seo/sitemap-entries.ts')).toMatch(/SELECT COALESCE\(kr\.ark_id, kr\.id\) AS id, kr\.slug, kr\.updated_at\s+FROM kamchatka_routes kr/);
  });

  it('карточка места: id из VIEW и ссылка по ЧПУ, если он есть', () => {
    expect(code('lib/places/place-detail.ts')).toMatch(/SELECT COALESCE\(kr\.ark_id, kr\.id\) AS id, kr\.slug, kr\.title/);
    expect(code('lib/places/place-detail.ts')).toMatch(/slug: \(rt\.slug as string \| null\) \?\? null/);
    expect(code('components/places/PlaceRoutes.tsx')).toMatch(/href=\{`\/routes\/\$\{r\.slug \?\? r\.id\}`\}/);
  });

  it('туры с карточки места — прямо на /catalog, без 308 через /marketplace', () => {
    expect(code('components/places/PlaceTours.tsx')).toMatch(/href=\{`\/catalog\/tours\/\$\{t\.id\}`\}/);
  });

  it('резолвер страницы по-прежнему ищет UUID в пространстве VIEW', () => {
    expect(code('app/routes/[id]/page.tsx')).toMatch(/FROM kamchatka_routes WHERE COALESCE\(ark_id, id\)::text = \$1/);
  });
});

describe('публичный блог читает из общей памяти агентов только дайджесты', () => {
  // agent_knowledge хранит и оценки ответов Кузьмича — outcome_kuz_<chatId>_<n>
  // с текстом туриста. Страница поста искала по одному slug и отдавала их
  // анонимно (152-ФЗ). Проверено на PostgreSQL: без условия строка находится.
  it('правило одно и не пропускает оценки ответов', () => {
    const scope = code('lib/blog/digest-scope.ts');
    expect(scope).toMatch(/type IN \('digest', 'decision'\)/);
    expect(scope).toMatch(/slug LIKE 'digest\/%' OR slug LIKE 'proposals\/%'/);
    expect(scope).not.toMatch(/outcome/);
  });

  it('страница поста и список блога оба ограничены этим правилом', () => {
    const page = code('app/blog/[slug]/page.tsx');
    expect(page).toMatch(/FROM agent_knowledge\s+WHERE slug = \$1\s+AND \$\{BLOG_DIGEST_SCOPE_SQL\}/);
    expect(page).not.toMatch(/WHERE slug = \$1\s+LIMIT/);
    expect(code('app/blog/page.tsx')).toMatch(/FROM agent_knowledge\s+WHERE \$\{BLOG_DIGEST_SCOPE_SQL\}/);
  });

  it('отказ базы не глушится ни в списке, ни на странице', () => {
    expect(code('app/blog/[slug]/page.tsx')).toMatch(/catch \(err\)[\s\S]{0,300}console\.error\('\[blog\/\[slug\]\]/);
    expect(code('app/blog/page.tsx')).toMatch(/catch \(err\)[\s\S]{0,300}console\.error\('\[blog\] дайджесты/);
  });
});

describe('блог не обещает того, чего SOS не делает', () => {
  it('сигнал уходит дежурному Ведара, а в МЧС — звонок 112', () => {
    const blog = read('app/blog/page.tsx');
    const sos = blog.slice(blog.indexOf("slug: 'sos-offline-guide'"), blog.indexOf("slug: 'operators-2026'"));
    expect(sos.length).toBeGreaterThan(500);
    expect(sos).not.toMatch(/отправятся в МЧС/);
    expect(sos).not.toMatch(/передаёт маршрут экстренным службам/);
    expect(sos).toMatch(/В МЧС сигнал сам не передаётся — туда звоните 112/);
    // Так и в коде: роут пишет дежурному в Telegram и сам велит звонить 112.
    const route = read('app/api/safety/sos/route.ts');
    expect(route).toMatch(/sendMessage/);
    expect(route).toMatch(/Звоните 112/);
  });
});
