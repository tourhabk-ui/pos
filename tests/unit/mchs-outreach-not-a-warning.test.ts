/**
 * Встреча службы с детьми — не тревога места (#3487, пункт 25).
 *
 * 17.11 пост МЧС «В Петропавловске-Камчатском второклассники познакомились с
 * работой кинологов» стоял в блоке «Есть предупреждение» на 168 карточках мест,
 * вплоть до Южно-Камчатского заказника за 224 км; на части карточек из-за него
 * было «Сегодня там опасно». Заголовок — настоящий. Тело поста восстановлено по
 * пересказам (полного текста с прода в этой пробе нет): рассказ о том, как
 * служебные собаки ищут людей под лавинами и завалами. Его слова угрозы и
 * давали ветке категории тревогу.
 *
 * Проверяется поведение трёх дверей:
 *   а) приём (`classifyMchsItem`, `classifyMchsItems`) не делает из такого
 *      поста события, а настоящие тревоги проходит как прежде;
 *   б) городская новость без предупреждения не получает зону `avachinsky`,
 *      а предупреждение о городе и тревога округа зону сохраняют;
 *   в) уже лежащая строка снимается следующим прогоном приёма
 *      (`pruneRejectedGenres`) — и с карточек тоже.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMchsItem, classifyMchsItems, isPublicOutreachPost, isCityNewsWithoutWarning,
} from '@/lib/services/safety/seismic-parser';
import { rejectedGenre, pruneRejectedGenres, type QueryFn } from '@/lib/services/safety/alert-prune';

const PUB = 'Tue, 17 Nov 2026 10:00:00 +1200';
const classify = (title: string, desc: string, prefix?: string) =>
  classifyMchsItem('x', title, desc, PUB, 'https://41.mchs.gov.ru/x', prefix);

const KINOLOGY_TITLE = 'В Петропавловске-Камчатском второклассники познакомились с работой кинологов';
const KINOLOGY_BODY = [
  'Кинологи поисково-спасательного отряда рассказали школьникам, как служебные собаки ищут людей под снежными лавинами и завалами после землетрясений.',
  'Ребята увидели, как собаки выполняют команды кинолога, и смогли погладить собак.',
  'Встреча прошла в рамках программы по профилактике детского травматизма.',
].join('\n');

describe('а) приём: встреча с детьми событием не становится', () => {
  it('пост RSS с заголовком — не тревога', () => {
    expect(isPublicOutreachPost(`${KINOLOGY_TITLE} ${KINOLOGY_BODY}`)).toBe(true);
    expect(classify(KINOLOGY_TITLE, KINOLOGY_BODY)).toBeNull();
    expect(classifyMchsItems('x', KINOLOGY_TITLE, KINOLOGY_BODY, PUB, 'https://41.mchs.gov.ru/x')).toEqual([]);
  });

  it('пост MAX без заголовка — ни целиком, ни абзацем про лавины', () => {
    // Без заголовка пост делится на абзацы, и абзац «собаки ищут людей под
    // лавинами» поодиночке ушёл бы лавинной тревогой. Жанр решается за пост.
    const post = `${KINOLOGY_TITLE}\n${KINOLOGY_BODY}`;
    expect(classifyMchsItems('m1', '', post, PUB, 'https://max.ru/x', 'max_mchs')).toEqual([]);
  });

  it('другие сюжеты того же жанра — тоже', () => {
    const outreach = [
      ['Пожарные провели экскурсию для школьников', 'Ребята примерили боевую одежду и узнали, как тушат лесные пожары.'],
      ['День открытых дверей в пожарно-спасательной части', 'Гости увидели технику, на которой спасатели выезжают на пожары и паводки.'],
      ['Урок безопасности в детском саду', 'Сотрудники МЧС напомнили воспитанникам, что делать при землетрясении и цунами.'],
      ['Подведены итоги конкурса детского рисунка «Спасатели глазами детей»', 'На рисунках — вулканы, лавины и спасательные вертолёты.'],
      ['Спасателей наградили за работу на вулкане Мутновском', 'Медали вручил начальник Главного управления.'],
    ];
    for (const [t, d] of outreach) {
      expect(isPublicOutreachPost(`${t} ${d}`), t).toBe(true);
      expect(classify(t, d), t).toBeNull();
    }
  });
});

describe('а) приём: настоящие тревоги проходят', () => {
  // Ошибка в эту сторону дороже: снять предупреждение — это молчание перед
  // опасностью. Каждая строка обязана остаться своим типом.
  const real: Array<[string, string, string]> = [
    ['avalanche', 'В горах Камчатки сохраняется лавинная опасность', 'Туристам не рекомендуется выходить на склоны в районе Авачинского перевала.'],
    ['volcanic_eruption', 'Пепловый выброс на вулкане Шивелуч', 'Высота пеплового облака до 8 км. Не рекомендуется приближаться к вулкану.'],
    ['weather', 'Штормовое предупреждение', 'Ожидается сильный ветер до 30 м/с по Камчатскому краю.'],
    ['road_closure', 'Закрыт проезд на Вилючинский перевал', 'Движение транспорта ограничено до улучшения погоды.'],
    ['park_closure', 'Приостановлено посещение маршрутов природного парка «Налычево»', 'Ограничение действует до 24 ноября включительно.'],
    // Дети и школа в тексте — не жанр встречи: это тревоги.
    ['weather', 'Занятия в школах отменены из-за циклона', 'В Петропавловске-Камчатском ожидается сильный ветер до 25 м/с и метель.'],
    ['volcanic_eruption', 'Экскурсии к вулкану Ключевской приостановлены', 'На вулкане газопепловый выброс, туристам не рекомендуется приближаться.'],
  ];
  for (const [type, t, d] of real) {
    it(`${type}: ${t}`, () => {
      expect(isPublicOutreachPost(`${t} ${d}`)).toBe(false);
      const ev = classify(t, d);
      expect(ev).not.toBeNull();
      expect(ev!.alert_type).toBe(type);
    });
  }

  it('пропавший турист и ребёнок на льду жанром встречи не считаются', () => {
    expect(isPublicOutreachPost('В районе вулкана Горелый пропал турист, его разыскивают спасатели')).toBe(false);
    expect(isPublicOutreachPost('Школьники вышли на тонкий лёд: спасатели напоминают — выход на лёд запрещён')).toBe(false);
  });

  it('объявление о проверке сирен жанром встречи не съедается', () => {
    const t = 'Плановая проверка систем оповещения населения 2 декабря';
    const d = 'В 10:00 в Петропавловске-Камчатском прозвучат сирены. Проверка пройдёт в рамках урока безопасности в школах. Это не сигнал опасности.';
    const ev = classify(t, d);
    // Сирена — своим родом и по-прежнему с зоной города.
    expect(ev?.alert_type).toBe('warning_test');
    expect(ev?.affected_zones).toContain('avachinsky');
  });
});

describe('б) городская новость без предупреждения — без зоны', () => {
  it('город назван, предупреждения нет — зона пустая, событие остаётся', () => {
    // Показ работы собак не узнан жанром встречи (адресата-детей нет), но
    // слов предупреждения в нём нет: место действия — город, а не охват.
    const d = 'В Петропавловске-Камчатском кинологи поисково-спасательного отряда показали, как собаки находят людей в лавине.';
    expect(isCityNewsWithoutWarning(d)).toBe(true);
    const ev = classify('', d);
    expect(ev?.alert_type).toBe('avalanche');
    expect(ev?.affected_zones).toEqual([]);
  });

  it('пост о кинологах вторая сеть тоже не пустила бы на зону', () => {
    // Если жанр встречи когда-нибудь его пропустит, на 168 карточек он не
    // разойдётся: город — единственная география, предупреждения нет.
    expect(isCityNewsWithoutWarning(`${KINOLOGY_TITLE} ${KINOLOGY_BODY}`)).toBe(true);
  });

  it('предупреждение о городе зону сохраняет', () => {
    const d = 'В Петропавловске-Камчатском ожидается сильный ветер до 25 м/с, возможен сход снега с крыш.';
    expect(isCityNewsWithoutWarning(d)).toBe(false);
    expect(classify('', d)?.affected_zones).toEqual(['avachinsky']);
  });

  it('медведь в городе зону сохраняет', () => {
    const d = 'В Петропавловске-Камчатском медведь вышел к жилым домам на улице Ленинградской.';
    expect(classify('', d)?.alert_type).toBe('bear');
    expect(classify('', d)?.affected_zones).toEqual(['avachinsky']);
  });

  it('назван округ или вулкан — правило молчит', () => {
    const district = 'В Петропавловске-Камчатском и Елизовском округе кинологи показали, как собаки находят людей в лавине.';
    expect(isCityNewsWithoutWarning(district)).toBe(false);
    expect(classify('', district)?.affected_zones).toEqual(['avachinsky']);
    const volcano = 'Кинологи из Петропавловска-Камчатского показали на склоне вулкана Авачинский, как собаки находят людей в лавине.';
    expect(isCityNewsWithoutWarning(volcano)).toBe(false);
    expect(classify('', volcano)?.affected_zones).toEqual(['avachinsky']);
  });
});

/** Мини-имитация БД, как в alert-prune.test.ts: помнит, что удалили. */
function fakeDb(rows: Array<{ id: string; title: string | null; description: string | null; created_at: string | null }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const q: QueryFn = async <T,>(sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (/SELECT[\s\S]*external_alerts/i.test(sql)) return { rows: rows as T[] };
    if (/UPDATE location_real_time_status/i.test(sql)) return { rows: [{ id: 'p1' }, { id: 'p2' }] as T[] };
    return { rows: [] as T[] };
  };
  return { q, calls };
}

describe('в) лежащая строка снимается следующим прогоном приёма', () => {
  it('по одному заголовку — запись уходит из базы и с карточек', async () => {
    expect(rejectedGenre(KINOLOGY_TITLE)).toBe('public_outreach');
    const avalanche = 'Сохраняется лавинная опасность на Авачинском перевале';
    const { q, calls } = fakeDb([
      { id: '101', title: KINOLOGY_TITLE, description: KINOLOGY_BODY, created_at: '2026-11-17T00:00:00Z' },
      { id: '102', title: avalanche, description: 'Туристам не рекомендуется выходить на склоны.', created_at: '2026-11-17T00:00:00Z' },
    ]);
    const r = await pruneRejectedGenres(q);
    expect(r.removed).toBe(1);
    expect(r.by_genre.public_outreach).toBe(1);
    const del = calls.find((c) => /DELETE FROM external_alerts/i.test(c.sql));
    expect(del!.params[0]).toEqual(['101']);
    const upd = calls.find((c) => /UPDATE location_real_time_status/i.test(c.sql));
    expect(upd!.params[0]).toEqual([KINOLOGY_TITLE]);
    expect(r.places_cleaned).toBe(2);
  });
});
