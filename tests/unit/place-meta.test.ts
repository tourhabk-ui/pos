/**
 * Сторож заголовка и сниппета места/маршрута из фактов (срез 02.10).
 *
 * Правило одно: в title и description попадает только то, чем карточка
 * располагает. Нет сезона — нет слова «сезон»; опасности из шаблона — не
 * факт; очерк добирает остаток, а не ведёт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  placeTitle, placeTitleTopics, placeDescription, routeDescription, routeFactsLine,
  PLACE_TITLE_FALLBACK, type PlaceMetaFacts,
} from '@/lib/seo/place-meta';
import { TITLE_LIMIT, BRAND_SUFFIX } from '@/lib/seo/title-fit';
import { META_DESCRIPTION_MAX } from '@/lib/seo/meta-description';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const geysers: PlaceMetaFacts = {
  name: 'Долина гейзеров',
  typeLabel: 'гейзер',
  zone: 'Кроноцкий заповедник',
  bestSeason: 'июль – сентябрь',
  altitudeM: 450,
  hazardsRecorded: true,
  registrationRequired: true,
  isOpen: null,
  essence: 'Я спускался в каньон по деревянным настилам, и пар стоял стеной. Одно из крупнейших гейзерных полей мира.',
};

describe('заголовок места — из ответов карточки', () => {
  it('сезон и опасности записаны — хвост называет все три ответа', () => {
    expect(placeTitleTopics(geysers)).toEqual(['как добраться', 'сезон', 'опасности']);
    expect(placeTitle(geysers)).toBe('Долина гейзеров: как добраться, сезон, опасности');
  });

  it('нет сезона и опасностей — только «как добраться»; ничего не выдумано', () => {
    const bare = { ...geysers, bestSeason: null, hazardsRecorded: false, registrationRequired: false };
    expect(placeTitle(bare)).toBe('Долина гейзеров: как добраться');
    expect(placeTitle(bare)).not.toContain('сезон');
  });

  it('регистрация в МЧС без записанных опасностей — тоже «опасности»', () => {
    expect(placeTitleTopics({ bestSeason: null, hazardsRecorded: false, registrationRequired: true })).toContain('опасности');
  });

  it('длинное имя — хвост короче, в предел выдачи укладывается', () => {
    const long = { ...geysers, name: 'Тимоновские термальные источники на реке Средняя Авача' };
    const t = placeTitle(long);
    expect(t.length + BRAND_SUFFIX.length).toBeLessThanOrEqual(Math.max(TITLE_LIMIT, long.name.length + PLACE_TITLE_FALLBACK.length + BRAND_SUFFIX.length));
    expect(t.startsWith(long.name)).toBe(true);
  });
});

describe('сниппет места — факты впереди, очерк следом', () => {
  it('тип, район, высота, сезон, МЧС — и только потом очерк', () => {
    const d = placeDescription(geysers);
    expect(d.startsWith('Долина гейзеров — гейзер на Камчатке, Кроноцкий заповедник. Высота 450 м. Сезон: июль – сентябрь. Нужна регистрация в МЧС.')).toBe(true);
    expect(d.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(d).not.toMatch(/\s$/);
  });

  it('очерк не ведёт: первая фраза «Я спускался…» стоит после фактов или не стоит вовсе', () => {
    const d = placeDescription(geysers);
    expect(d.startsWith('Я спускался')).toBe(false);
  });

  it('закрыто сейчас — сказано; открыто — не обещается', () => {
    expect(placeDescription({ ...geysers, isOpen: false })).toContain('Сейчас закрыто.');
    expect(placeDescription({ ...geysers, isOpen: true })).not.toContain('открыто');
  });

  it('тип не записан — «место на Камчатке», без выдуманного типа; пустой очерк не падает', () => {
    const d = placeDescription({ ...geysers, typeLabel: 'место', zone: null, altitudeM: null, bestSeason: null, registrationRequired: false, essence: null });
    expect(d).toBe('Долина гейзеров — место на Камчатке.');
  });
});

describe('сниппет маршрута — факты впереди', () => {
  const r = {
    title: 'Вулкан Горелый', zone: 'Мутновский район', distanceKm: 12, durationHours: 6.5, durationDays: null,
    elevationGainM: 700, difficulty: 'medium', season: 'summer', mchsRequired: true,
    description: 'Подъём по северному склону к кратерным озёрам. Тропа маркирована, воды по пути нет.',
  };
  it('строка фактов и регистрация в МЧС', () => {
    expect(routeFactsLine(r)).toBe('12 км · набор 700 м · 6,5 ч · сложность средняя · сезон лето');
    const d = routeDescription(r);
    expect(d.startsWith('Маршрут на Камчатке, Мутновский район: 12 км · набор 700 м · 6,5 ч · сложность средняя · сезон лето. Регистрация в МЧС обязательна.')).toBe(true);
    expect(d.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
  });
  it('многодневный — дни вместо часов; без фактов — только описание', () => {
    expect(routeFactsLine({ ...r, durationDays: 3 })).toContain('3 дн.');
    expect(routeFactsLine({ ...r, durationDays: 3 })).not.toContain('6,5 ч');
    const none = { ...r, zone: null, distanceKm: null, durationHours: null, elevationGainM: null, difficulty: null, season: null, mchsRequired: false };
    expect(routeDescription(none)).toBe('Маршрут на Камчатке. Подъём по северному склону к кратерным озёрам. Тропа маркирована, воды по пути нет.');
  });
});

describe('связка со страницами', () => {
  it('карточка места собирает title/description из place-meta и читает факты теми же таблицами, что карточка', () => {
    const src = read('app/places/[id]/page.tsx');
    expect(src).toContain('title: placeTitle(facts)');
    expect(src).toContain('placeDescription(facts)');
    expect(src).toContain('LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id');
    expect(src).toContain('LEFT JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id');
    // Опасности из шаблона — не факт (lib/safety/profile-source), как на карточке.
    expect(src).toMatch(/hazardsRecorded: hazards\.length > 0 && mayStateAsFact\(/);
    expect(src).not.toContain("fitTitle(r.name as string, [' — место на Камчатке'])");
  });

  it('карточка маршрута берёт факты из kamchatka_routes и строит сниппет из них', () => {
    const src = read('app/routes/[id]/page.tsx');
    expect(src).toContain('LEFT JOIN kamchatka_routes kr ON COALESCE(kr.ark_id, kr.id) = k.id');
    expect(src).toContain('const desc = routeDescription({');
    expect(src).not.toContain('const desc = metaDescription(route.description)');
  });

  it('картинка превью по умолчанию — 1200×630, и нигде не осталось квадрата героя в openGraph', () => {
    const og = read('lib/seo/og-image.ts');
    expect(og).toContain("url: DEFAULT_OG_IMAGE");
    expect(og).toMatch(/width: 1200,\s*height: 630/);
    for (const p of ['app/page.tsx', 'app/plans/[slug]/page.tsx', 'app/trip/[token]/page.tsx']) {
      expect(read(p), p).not.toContain("url: '/images/hero/hero-light.jpeg'");
    }
  });

  it('хабы блога и статей называют разные намерения и ссылаются друг на друга', () => {
    const blog = read('app/blog/page.tsx');
    const articles = read('app/articles/page.tsx');
    expect(blog).toMatch(/title: 'Новости сезона на Камчатке/);
    expect(articles).toMatch(/title: 'Справочник о Камчатке/);
    expect(blog).toContain('href="/articles"');
    expect(articles).toContain('href="/blog"');
  });

  it('/safety: заголовок — вопрос, на который страница отвечает живыми данными', () => {
    expect(read('app/safety/page.tsx')).toMatch(/title: 'Безопасно ли сейчас на Камчатке/);
    // Проверяется текст H1, а не его классы: размер на телефоне меняли
    // отдельно (03.10, заголовок занимал треть первого экрана).
    expect(read('app/safety/_SafetyClient.tsx')).toMatch(/<h1 className="ds-h1[^"]*"[^>]*>Безопасно ли сейчас на Камчатке<\/h1>/);
  });
});
