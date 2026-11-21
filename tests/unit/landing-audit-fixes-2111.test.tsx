/**
 * Аудит неточностей 21.11.2026: фактические правки посадочных и подпись цены.
 */
import { describe, it, expect } from 'vitest';
import { parseArticleMarkdown } from '@/lib/articles/markdown';
import { landingBySlug } from '@/lib/landings/landings';
import { tourBlockNote } from '@/lib/landings/tours';

const body = (slug: string) => {
  const l = landingBySlug(slug);
  return `${l.before}\n${l.after}`;
};

describe('климат Петропавловска — «Погода и климат», станция 32583, 21.11.2026', () => {
  it('месячные таблицы и годовая сумма совпадают с первоисточником', () => {
    const official: Record<string, number> = {
      'kamchatka-v-yanvare': 110,
      'kamchatka-v-fevrale': 77,
      'kamchatka-v-marte': 104,
      'kamchatka-v-aprele': 89,
      'kamchatka-v-mae': 59,
      'kamchatka-v-iyune': 56,
      'kamchatka-v-iyule': 64,
      'kamchatka-v-avguste': 92,
      'kamchatka-v-sentyabre': 101,
      'kamchatka-v-oktyabre': 157,
      'kamchatka-v-noyabre': 161,
      'kamchatka-v-dekabre': 118,
    };
    for (const [slug, mm] of Object.entries(official)) {
      const text = body(slug);
      expect(text, slug).toMatch(new RegExp(`Петропавловск-Камчатский \\|[^\\n]+\\|\\s*${mm}\\s*мм`));
      expect(text, slug).toContain('pogodaiklimat.ru/climate/32583.htm');
    }
    expect(body('kamchatka-v-yanvare')).toMatch(/1187 мм/);
    expect(body('kamchatka-v-oktyabre')).not.toMatch(/самый дождливый месяц года/);
    expect(body('kamchatka-v-noyabre')).toMatch(/самый дождливый месяц в Петропавловске/);
    expect(body('pogoda-na-kamchatke-po-mesyacam')).toMatch(/максимум в ноябре, 161 мм/);
    expect(body('pogoda-na-kamchatke-po-mesyacam')).not.toMatch(/1177 мм|172 мм/);
  });
});

describe('Новый год: постановление № 1187 — про 2027 год', () => {
  it('31.12.2026 назван четвергом и опирается на № 1466, а № 1187 — на 31.12.2027', () => {
    const text = body('novyj-god-na-kamchatke');
    expect(text).toMatch(/31 декабря 2026 года — четверг/);
    expect(text).toMatch(/24\.09\.2025 № 1466/);
    expect(text).toMatch(/на пятницу 31 декабря 2027 года/);
    expect(text).toContain('cons_doc_LAW_515170');
    expect(text).not.toMatch(/перенесён на пятницу 31 декабря, а с субботы 2 января/);
    expect(text).toMatch(/около 110 мм/);
  });
});

describe('Как добраться: расписание аэропорта 21.11.2026', () => {
  it('в ответе про прямые рейсы есть Харбин и нет Магадана как текущего рейса', () => {
    const text = body('kak-dobratsya-na-kamchatku');
    expect(text).toMatch(/Харбин/);
    expect(text).toMatch(/Магадана в этом расписании нет/);
    expect(text).not.toMatch(/связывают Камчатку с Москвой, Новосибирском, Владивостоком, Хабаровском, Южно-Сахалинском и Магаданом/);
    expect(text).not.toMatch(/Магадан и Анадырь есть в списке направлений/);
    expect(text).toMatch(/Википедия относит рейсы в Магадан к «Камчатским авиалиниям», но в расписании аэропорта на 21 ноября 2026 года их нет/);
  });
});

describe('Камчатка с детьми: прошедший сезон не подан как текущий', () => {
  it('семейные туры — сезон закончился 15.09.2026; признака «для детей» нет', () => {
    const text = body('kamchatka-s-detmi');
    expect(text).toMatch(/закончился 15 сентября 2026/);
    expect(text).toMatch(/Признака «для детей» у туров на Ведаре нет/);
    expect(text).not.toMatch(/с сезоном 1 июня — 15 сентября/);
    expect(text).not.toMatch(/пометки «Подходит новичкам»/);
  });
});

describe('Паратунка: круглосуточно не обобщается на все бассейны', () => {
  it('оговорка отнесена к конкретному объекту', () => {
    const text = body('paratunka');
    expect(text).toMatch(/конкретному объекту/);
    expect(text).not.toMatch(/для гостей санаториев — и круглосуточно/);
  });
});

describe('Пропуск Устой-М: закрытие маршрутов — по новости парка', () => {
  it('источник — новость «Вулканов Камчатки» от 02.11.2026, не самоцитата', () => {
    const text = body('propusk-ustoj-m-vilyuchinskij-pereval');
    expect(text).toContain('vulcanikamchatki.ru/novosti/zakrytie_marshrutov4');
    expect(text).toMatch(/от 02\.11\.2026/);
    expect(text).not.toMatch(/По данным страницы Ведара на 21\.11\.2026/);
  });
});

describe('Подпись блока туров', () => {
  it('не обещает «цену «от»», если карточка печатает сумму без «от»', () => {
    expect(tourBlockNote({ kind: 'all' })).toMatch(/без добавленного «от»/);
    expect(tourBlockNote({ kind: 'all' })).not.toMatch(/Цена «от» и даты/);
    expect(tourBlockNote({ kind: 'month', month: 1 })).not.toMatch(/Цена «от» и даты/);
    expect(tourBlockNote({ kind: 'topic', topic: 'tolbachik' })).not.toMatch(/Цена «от» и даты/);
  });
});

describe('ссылки со скобками на живых посадочных', () => {
  it('источники разбора не обрезаются на «_» перед скобкой', () => {
    const slugs = [
      'kak-dobratsya-na-kamchatku',
      'kamchatka-v-yanvare',
      'kamchatka-v-iyule',
      'morskie-progulki-kamchatka',
      'paratunka',
    ];
    for (const slug of slugs) {
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
      const bad = hrefs.filter((h) => /wikipedia\.org\/wiki\/[^/]+_$/.test(h));
      expect(bad, slug).toEqual([]);
    }
  });
});

describe('Долина гейзеров: расхождения из комментария к #3487, 21.11.2026', () => {
  it('посадочная опирается на заповедник и не цитирует оператора на паузе', () => {
    const l = landingBySlug('dolina-gejzerov-kak-popast');
    expect(l.path).toBe('/dolina-gejzerov-ekskursiya');
    expect(l.date).toBe('2026-11-21');
    const text = `${l.before}\n${l.after}`;
    expect(text).toMatch(/2–2,5 часа/);
    expect(text).toMatch(/котловина размером 9×12 км/);
    expect(text).toMatch(/Список туроператоров, организующих туры в заповедник/);
    expect(text).toMatch(/в названную на карточке цену не входят/);
    expect(text).toMatch(/месячник тишины/);
    expect(text).toMatch(/Сезонное окно на странице тура — рамка/);
    expect(text).not.toMatch(/аккредитованн/);
    expect(text).not.toMatch(/крупнейших гейзерных полей/);
    expect(text).not.toMatch(/Местечко/);
    expect(text).not.toMatch(/mestechko-dolina-geyzerov/);
    expect(text).not.toMatch(/зимние вылеты/);
    expect(text).toContain('kronoki.ru/ru/visit/information-for-all/excursions/147.html');
    expect(text).toContain('kronoki.ru/ru/visit/information-for-all/excursions/158.html');
  });
});
