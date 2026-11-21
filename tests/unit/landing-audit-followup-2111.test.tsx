/**
 * Второй заход аудита 21.11.2026 (перепроверка Гло 32c39635):
 * хвосты FAQ, пункты не из #3632 и формулировки «требует проверки».
 */
import { describe, it, expect } from 'vitest';
import { parseArticleMarkdown } from '@/lib/articles/markdown';
import { landingBySlug } from '@/lib/landings/landings';

const body = (slug: string) => {
  const l = landingBySlug(slug);
  expect(l, slug).toBeTruthy();
  return `${l.before}\n${l.after}`;
};

const hrefsOf = (slug: string) => {
  const blocks = parseArticleMarkdown(body(slug));
  const hrefs: string[] = [];
  const walk = (nodes: { t: string; href?: string; c?: unknown }[]) => {
    for (const n of nodes) {
      if (n.t === 'link' && n.href) hrefs.push(n.href);
      if (Array.isArray((n as { c?: unknown }).c)) walk((n as { c: { t: string; href?: string }[] }).c);
    }
  };
  for (const b of blocks) {
    if ('c' in b && Array.isArray(b.c)) walk(b.c as never);
    if ('items' in b) for (const it of b.items) walk(it as never);
    if ('head' in b) {
      for (const c of b.head) walk(c as never);
      for (const r of b.rows) for (const c of r) walk(c as never);
    }
  }
  return hrefs;
};

describe('хвосты FAQ после #3632', () => {
  it('/kamchatka-v-oktyabre: самый дождливый — ноябрь; 157 против 56 мм по станции 32583', () => {
    const text = body('kamchatka-v-oktyabre');
    const l = landingBySlug('kamchatka-v-oktyabre');
    expect(`${l.title}\n${l.description}\n${l.h1}\n${text}`).not.toMatch(
      /Октябрь — самый дождливый месяц и конец/,
    );
    expect(text).toMatch(/157 против 56 мм/);
    expect(text).toMatch(/161 мм/);
    expect(text).not.toMatch(/172 против 56/);
    expect(text).toContain('pogodaiklimat.ru/climate/32583.htm');
  });

  it('/kamchatka-s-detmi FAQ не подаёт сезон 1 июня — 15 сентября как текущий', () => {
    const text = body('kamchatka-s-detmi');
    expect(text).toMatch(/Есть ли семейные туры\?/);
    expect(text).toMatch(/закончился 15 сентября/);
    expect(text).not.toMatch(/с 1 июня по 15 сентября/);
    expect(text).toMatch(/Подходит ли детям морская прогулка\?/);
    expect(text).toMatch(/уточняйте у оператора/);
    const after = text.split('Подходит ли детям морская прогулка?')[1] ?? '';
    const nextQ = after.indexOf('**Какой музей');
    expect(nextQ).toBeGreaterThan(20);
  });

  it('Паратунка FAQ относит круглосуточную работу к конкретному объекту', () => {
    const text = body('paratunka');
    expect(text).toMatch(/Работают ли бассейны зимой\?/);
    const faq = text.split('Работают ли бассейны зимой?')[1] ?? '';
    const ans = faq.split('**Можно ли')[0];
    expect(ans).toMatch(/конкретному объекту/);
    expect(ans).not.toMatch(/для гостей санаториев — круглосуточно/);
  });
});

describe('ссылки на карточки «Местечка» в текстах статей на время паузы', () => {
  it('на трёх названных страницах нет ссылок на /catalog/tours/mestechko-*', () => {
    for (const slug of [
      'morskie-progulki-kamchatka',
      'kamchatka-s-detmi',
      'tolbachik-samostoyatelno',
    ]) {
      const hrefs = hrefsOf(slug).filter((h) => /\/catalog\/tours\/mestechko-/.test(h));
      expect(hrefs, slug).toEqual([]);
      expect(body(slug), slug).not.toMatch(/\]\(\/catalog\/tours\/mestechko-/);
    }
  });
});

describe('климат, базы, Берингия, лосось, источники «требует проверки»', () => {
  it('на горнолыжных базах — цифры спортшколы, без «самой крупной» базы', () => {
    const text = body('gornolyzhnye-bazy-kamchatki');
    expect(text).toMatch(/418 м/);
    expect(text).toMatch(/перепад высот 300 м|перепад — 300 м|перепад 300 м/);
    expect(text).toMatch(/315 до 980 м/);
    expect(text).toMatch(/перепад 335 м/);
    expect(text).toMatch(/школа публикует как есть|эти три цифры школа/);
    expect(text).toMatch(/7 склонов/);
    expect(text).toMatch(/8 трасс/);
    expect(text).toContain('edelweis-kam.ru/about/bases.html');
    expect(text).not.toMatch(/самая крупная\?\*\*.*«Морозная»/);
    expect(text).toMatch(/кресельная дорога длиной около 1650 м/);
  });

  it('январская страница берёт характеристики «Красной сопки» с сайта школы', () => {
    const text = body('kamchatka-v-yanvare');
    expect(text).toMatch(/верхняя точка 418 м, перепад высот 300 м, 4 трассы длиной от 315 до 980 м/);
    expect(text).toContain('edelweis-kam.ru/about/bases.html');
    expect(text).not.toMatch(/три трассы длиной до 1400/);
    expect(text).not.toMatch(/крупнейшее событие камчатской зимы/);
  });

  it('финиш «Берингии-2026» — у реки Поперечная, со ссылкой на «Кам 24» / минтуризм', () => {
    for (const slug of ['kamchatka-v-marte', 'kamchatka-v-fevrale']) {
      const text = body(slug);
      expect(text, slug).toMatch(/реки Поперечная/);
      expect(text, slug).toContain('kam24.ru/news/main/20260328/126724.html');
    }
  });

  it('«лосось» не стоит отдельным видом рядом с чавычей, кетой и кижучем', () => {
    expect(body('kogda-ehat-na-kamchatku')).toMatch(/Тихоокеанские лососи — с июня по октябрь/);
    expect(body('kogda-ehat-na-kamchatku')).not.toMatch(/\*\*Лосось — с июня по октябрь/);
    for (const slug of [
      'kamchatka-v-mae',
      'kamchatka-v-iyune',
      'kamchatka-v-iyule',
      'kamchatka-v-avguste',
      'kamchatka-v-sentyabre',
    ]) {
      expect(body(slug), slug).not.toMatch(/форель, лосось, краб/);
    }
  });

  it('268 обращений МЧС — с официальной страницы и доступным пересказом', () => {
    for (const slug of ['stoit-li-ekhat-na-kamchatku', 'medvedi-kamchatki']) {
      const text = body(slug);
      expect(text, slug).toMatch(/268 обращен/);
      expect(text, slug).toContain('41.mchs.gov.ru/deyatelnost/press-centr/vse_novosti/5368827');
      expect(text, slug).toContain('kamtoday.ru/news/poluostrov/268-soobshcheniy-o-medvedyakh');
    }
  });

  it('окна и 30 км/ч у Устой-М не выдаются за регламент подрядчика', () => {
    const text = body('propusk-ustoj-m-vilyuchinskij-pereval');
    expect(text).toMatch(/не регламент с сайта подрядчика|сверяйтесь с «Устой-М»/);
  });

  it('Tripmir на странице Толбачика оговорён как неофициальный агрегатор', () => {
    const text = body('tolbachik-samostoyatelno');
    expect(text).toMatch(/не официальные данные парка/);
  });

  it('расстояние до аэропорта оставлено диапазоном источников, без одной выдуманной цифры', () => {
    const text = body('kak-dobratsya-na-kamchatku');
    expect(text).toMatch(/источники называют по-разному/);
    expect(text).toMatch(/25 км/);
    expect(text).not.toMatch(/летом цены вырастают в среднем в три раза/);
    expect(text).toMatch(/главными воздушными воротами Камчатки/);
  });

  it('Ключевская — самый высокий, не «крупнейший», с цифрой 4750 м', () => {
    const text = body('chto-posmotret-na-kamchatke');
    expect(text).not.toMatch(/крупнейший действующий вулкан Евразии/);
    expect(text).toMatch(/4750 м/);
  });

  it('регистрация маршрута: и формулировка портала, и рекомендация парка', () => {
    const solo = body('kamchatka-samostoyatelno');
    expect(solo).toMatch(/настоятельную рекомендацию/);
    expect(body('tolbachik-samostoyatelno')).toMatch(/настоятельно рекомендует|рекоменд/);
  });
});
