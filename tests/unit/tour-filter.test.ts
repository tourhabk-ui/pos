/**
 * Сторож фильтра `get_tours` (сверка MCP 25.09): «вулканы» — не тип тура, и
 * ответ «по типу нет» плюс полный каталог рыбалки читался как подмена.
 *
 * Ловушка MCP 29.10 (filter-coverage): слово искалось в напечатанной строке
 * каталога целиком — с «Оп: Край Вулканов» и служебным «заявка оператору», —
 * а полное описание и программа не читались. Прежняя фикстура этого файла
 * была строкой БЕЗ «Оп:», и проверка «ID47 не упоминает вулкан» проходила на
 * форме, какой прод не выдаёт. Теперь каталог строит настоящий загрузчик
 * (lib/kuzmich/core, loadTourCatalogEntries) из строк-объектов с компаниями и
 * служебными сегментами — строка той же формы, что у прода, и указатель
 * настоящим tourMatchEntry (lib/search/tour-match). База подменена.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/planner', () => ({}));

import { pool } from '@/lib/db-pool';
import { filterTourCatalog, paginateTourText, FAR_BLOCK_MARK, NEAR_FIELDS, NO_SELLER_NAMES } from '@/lib/kuzmich/tour-filter';
import { activityLabel } from '@/lib/tours/labels';
import { EN_TO_RU, SHORT_STEMS, SHORT_STEMS_NOT_SEARCHED } from '@/lib/search';
import type { TourCatalog } from '@/lib/kuzmich/core';

const q = pool.query as unknown as ReturnType<typeof vi.fn>;

type Row = Record<string, unknown> & { id: number };
/** Строка базы, как её отдаёт SELECT каталога: без расписания, с деталями и компанией. */
const row = (id: number, over: Record<string, unknown>): Row => ({
  id, title: `Тур ${id}`, base_price: 10000, price_unit: 'per_person', multi_day_count: null,
  activity_type: 'trekking', location_name: null, duration_type: null, duration_hours: null,
  season_start: null, season_end: null, available_slots: null, next_available_date: null,
  short_description: null, has_schedule: false, has_details: true, operator_name: 'Край Вулканов',
  description: null, program_text: null, main_place_name: null, main_place_type: null,
  ...over,
});

/** Каталог настоящим загрузчиком на подменённой базе; модуль — новый, кэш пуст. */
async function catalogOf(rows: Row[]): Promise<TourCatalog> {
  q.mockReset();
  q.mockResolvedValue({ rows });
  vi.resetModules();
  const { loadTourCatalogEntries } = await import('@/lib/kuzmich/core');
  const cat = await loadTourCatalogEntries();
  if (!cat) throw new Error('каталог не собрался');
  return cat;
}

const ids = (s: string) => s.match(/^ID\d+/gm) ?? [];
/** Порядок каталога (правило 1в, жребий дня) — из самого текста, а не угадан. */
const inCatalogOrder = (cat: TourCatalog, want: number[]) => ids(cat.text).filter((x) => want.includes(Number(x.slice(2))));
const filter = (cat: TourCatalog, want: string, farCap?: number) =>
  filterTourCatalog(cat.text, want, { activityLabel, entries: cat.entries, farCap });
/** Блоки ответа: до пояснения «Ещё упоминают», от него до блока (в), блок (в). */
function blocks(out: string) {
  const farAt = out.indexOf(FAR_BLOCK_MARK);
  const nearAt = out.search(/упоминают «|упоминается «/);
  const end = (n: number) => (n >= 0 ? n : out.length);
  return {
    typed: ids(out.slice(0, Math.min(end(nearAt), end(farAt)))),
    near: nearAt >= 0 ? ids(out.slice(nearAt, end(farAt))) : [],
    far: farAt >= 0 ? ids(out.slice(farAt)) : [],
  };
}

describe('get_tours: слово туриста', () => {
  let cat: TourCatalog;
  beforeAll(async () => {
    cat = await catalogOf([
      row(1, { title: 'Рыбалка на Большой', activity_type: 'fishing', multi_day_count: 3 }),
      row(2, { title: 'Сплав по Быстрой', activity_type: 'rafting', short_description: 'с видом на вулканы Авачинской группы' }),
      row(3, { title: 'Бухта Русская', activity_type: 'boat_trip', short_description: 'морская прогулка, по желанию дайвинг у скал' }),
    ]);
  });

  it('тип находится по русской метке', () => {
    const out = filter(cat, 'рыбалка');
    expect(blocks(out).typed).toEqual(['ID1']);
    expect(out).not.toContain('ID2:');
  });

  it('тип находится и по короткой подписи: «море» — морская прогулка, хотя слова «море» в её тексте нет', () => {
    // Короткая подпись boat_trip — «Море»; в тексте тура только «морская».
    expect(blocks(filter(cat, 'море')).typed).toEqual(['ID3']);
  });

  it('вид отдыха, туров этого типа нет, но слово упомянуто — с пометкой «тип другой», шапка и хвост на месте', () => {
    const out = filter(cat, 'дайвинг');
    expect(out).toMatch(/^Тура с типом «дайвинг» нет\./);
    expect(out).toContain('тип у них другой');
    expect(ids(out)).toEqual(['ID3']);
    // Правило порядка (§0) названо и в этой ветке, хвост каталога тоже.
    expect(out).toContain('РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ');
    expect(out).toContain('Порядок туров — правило платформы');
    expect(out).toContain('Когда турист спрашивает о конкретном туре');
  });

  it('нигде нет — сказано, где искали, и каталог только как замена с оговоркой', () => {
    const out = filter(cat, 'гейзеры');
    expect(out).toMatch(/^Туров «гейзеры» у операторов платформы сейчас нет — ни по типу, ни в названии, месте, кратком и полном описании или программе тура\./);
    expect(out).toContain('Имена компаний и гидов get_tours не ищет');
    expect(out).toContain('Не выдавай другие туры за такие');
  });
});

// 08.10: тип сравнивался подписью целиком, и «вулканы» не находили volcano
// («Восхождение на вулкан»), а сам тур уходил в «тип у них другой».
describe('get_tours: тип — по основе слова, во всех регистрах подписи', () => {
  let cat: TourCatalog;
  beforeAll(async () => {
    cat = await catalogOf([
      row(41, { title: 'Вулкан Плоский Толбачик', location_name: 'Вулкан Плоский Толбачик', activity_type: 'trekking', multi_day_count: 4 }),
      row(45, { title: 'Экскурсия в Долину гейзеров и кальдеру вулкана Узон', location_name: 'Долина гейзеров', activity_type: 'helicopter' }),
      row(46, { title: 'Восхождение на вулкан Ключевская Сопка', location_name: 'Вулкан Ключевская Сопка', activity_type: 'volcano', multi_day_count: 12 }),
      // «Вулкан» у этого тура — только в имени компании.
      row(47, { title: 'Автомобильный тур на Курильское озеро', location_name: 'Курильское озеро', activity_type: 'bears', multi_day_count: 7 }),
      row(27, { title: 'Сплав по реке Быстрая', location_name: 'Река Быстрая', activity_type: 'rafting', operator_name: 'Камчатка Семейный Рафтинг' }),
    ]);
  });

  it('«вулканы» находят тип volcano; упоминания при другом типе — следом, с оговоркой; имя компании — не упоминание', () => {
    const out = filter(cat, 'вулканы');
    expect(out).not.toMatch(/Тура с типом «вулканы» нет/);
    const b = blocks(out);
    expect(b.typed).toEqual(['ID46']);
    expect(b.near).toEqual(inCatalogOrder(cat, [41, 45]));
    // Строка ID47 несёт «Оп: Край Вулканов» — а тура про вулкан там нет.
    expect(cat.text).toMatch(/^ID47: .*\| Оп: Край Вулканов/m);
    expect(out).not.toContain('ID47:');
    expect(out).not.toContain('ID27:');
    expect(out).toContain(`Ещё упоминают «вулканы» ${NEAR_FIELDS}`);
    expect(out.startsWith('РЕАЛЬНЫЕ ТУРЫ')).toBe(true);
    expect(out).toContain('Когда турист спрашивает о конкретном туре');
  });

  it.each([
    ['вулкан', 'ID46'], ['volcano', 'ID46'], ['восхождение', 'ID46'],
    ['медведи', 'ID47'], ['сплав', 'ID27'], ['вертолёт', 'ID45'], ['вертолет', 'ID45'],
    ['трекинг', 'ID41'], ['треккинг', 'ID41'],
  ])('«%s» → %s по типу', (word, id) => {
    const out = filter(cat, word);
    // Ветка «совпал тип», а не «туров нет» с приложенным каталогом: в том
    // каталоге нужный ID тоже есть, и проверка «содержит» его не отличила бы.
    expect(out.startsWith('РЕАЛЬНЫЕ ТУРЫ')).toBe(true);
    expect(blocks(out).typed).toEqual([id]);
  });

  it('просьба из нескольких слов — каждое у одного типа', () => {
    // «наблюдение» есть в подписи медведей, «китами» — нет: это не медведи.
    // Ни тип, ни тексты: ответ «нет», а каталог после него — замена.
    expect(filter(cat, 'наблюдение за китами')).toMatch(/^Туров «наблюдение за китами» у операторов платформы сейчас нет/);
  });

  it('«туры» — общее слово: весь каталог как ответ, без «нет» и без каталога «для замены»', () => {
    const out = filter(cat, 'туры');
    expect(out).toMatch(/^«туры» — общее слово: вида отдыха или места в нём нет/);
    expect(ids(out)).toEqual(ids(cat.text));
    expect(out).not.toMatch(/нет\.|для замены/);
  });

  // Ревью 29.10: «туры» было обязательной основой и отсеивало туры случайно.
  it('общие слова каталога не сужают: «туры на вулканы» — как «вулканы», «вертолётные туры» и «helicopter tours» — тип', () => {
    expect(blocks(filter(cat, 'туры на вулканы'))).toEqual(blocks(filter(cat, 'вулканы')));
    expect(blocks(filter(cat, 'туры на вулканы')).typed).toEqual(['ID46']);
    expect(blocks(filter(cat, 'вертолётные туры')).typed).toEqual(['ID45']);
    expect(blocks(filter(cat, 'helicopter tours')).typed).toEqual(['ID45']);
    expect(blocks(filter(cat, 'volcano tours')).typed).toEqual(['ID46']);
    expect(filter(cat, 'вертолётные туры')).toContain('«туры» — общее слово каталога, по нему не сужал.');
  });
});

// 13.10, владелец: «тур на Авачинский вулкан есть». Ответ начинался словами
// «Тура с типом «авачинский вулкан» нет», и модель отвечала «туров нет», хотя
// ниже стояли все пять туров.
describe('get_tours: название места — не вид отдыха', () => {
  let cat: TourCatalog;
  beforeAll(async () => {
    cat = await catalogOf([
      row(46, { title: 'Восхождение на вулкан Ключевская Сопка', location_name: 'Вулкан Ключевская Сопка', activity_type: 'volcano' }),
      row(52, { title: 'Авачинский перевал (снегоход)', location_name: 'Авачинский перевал', activity_type: 'snowmobile', operator_name: 'Местечко Камчатка',
        short_description: 'Зимняя снегоходная экскурсия по руслу Сухой речки к подножию Авачинского и Корякского вулканов.' }),
      row(62, { title: 'Авачинский перевал', location_name: 'Авачинский перевал', activity_type: 'jeep_safari', operator_name: 'Местечко Камчатка',
        short_description: 'Джип-тур по руслу Сухой речки к Авачинскому перевалу и подъём на экструзию Верблюд между Авачинским и Корякским вулканами.' }),
      row(55, { title: 'Облёт Корякского и Авачинского с Налычевскими источниками', location_name: 'Вулканы Корякский и Авачинский, Налычевские источники',
        activity_type: 'helicopter', operator_name: 'Местечко Камчатка' }),
      row(47, { title: 'Автомобильный тур на Курильское озеро', location_name: 'Курильское озеро, Паужетка', activity_type: 'bears',
        short_description: 'два дня наблюдения за медведями на кордоне Озёрный' }),
    ]);
  });

  it('«авачинский вулкан»: без «туров нет» впереди — туры к месту и просьба назвать их', () => {
    const out = filter(cat, 'авачинский вулкан');
    expect(out).not.toMatch(/Тура с типом|туров .*нет|тип у них другой/i);
    expect(out.startsWith('РЕАЛЬНЫЕ ТУРЫ')).toBe(true);
    expect(out).toContain(`Туры, где упоминается «авачинский вулкан» (${NEAR_FIELDS})`);
    expect(out).toContain('Назови их');
    expect(ids(out)).toEqual(inCatalogOrder(cat, [52, 62, 55]));
    expect(out).toContain('Когда турист спрашивает о конкретном туре');
  });

  it('то же для озера; вид отдыха по-прежнему идёт по типу', () => {
    const lake = filter(cat, 'курильское озеро');
    expect(lake).not.toMatch(/Тура с типом/);
    expect(ids(lake)).toEqual(['ID47']);
    const bears = filter(cat, 'медведи');
    expect(blocks(bears).typed).toEqual(['ID47']);
  });
});

// Ловушка MCP 29.10, filter-coverage: что ищется и где — по полям тура.
describe('get_tours: поля тура, а не строка каталога (29.10)', () => {
  const SHIP = 'Экспедиционный круиз на Командоры';
  let cat: TourCatalog;
  beforeAll(async () => {
    cat = await catalogOf([
      row(46, { title: 'Восхождение на вулкан Ключевская Сопка', activity_type: 'volcano' }),
      // Только имя компании со словом «вулкан» и служебные «заявка», «детали».
      row(47, { title: 'Автомобильный тур на Курильское', activity_type: 'bears', short_description: 'два дня наблюдения за медведями на кордоне' }),
      row(44, { title: SHIP, activity_type: 'boat_trip' }),
      row(65, { title: 'Толбачик на джипах', activity_type: 'jeep_safari', operator_name: 'Лагуна Экспедиция', short_description: 'джип-экспедиция к лавовым полям' }),
      row(98, { title: 'Облёт двух вершин', activity_type: 'helicopter', operator_name: 'Лагуна Экспедиция',
        description: 'Час в воздухе, панорама на Домашние вулканы и океан.' }),
      row(30, { title: 'Город и океан', activity_type: 'sightseeing', operator_name: 'Лагуна Экспедиция' }),
      // Главное место — озеро; слова «озеро» нет ни в названии, ни в описании.
      row(81, { title: 'Охотское побережье, 4 дня', activity_type: 'jeep_safari', operator_name: 'Андрей Запорожец',
        main_place_name: 'Курильское', main_place_type: 'lake',
        description: 'Кутхины Баты — пемзовые скалы, похожие на поставленные вертикально байдарки.',
        program_text: 'День 1. Паужетка Переезд вдоль Охотского моря.' }),
      // Главное место — вулкан: слово «вулкан» даёт подпись типа места.
      row(70, { title: 'Горелый за день', activity_type: 'jeep_safari', operator_name: 'Андрей Запорожец',
        main_place_name: 'Горелый', main_place_type: 'volcano' }),
      row(54, { title: 'Долина гейзеров', activity_type: 'helicopter', operator_name: 'Местечко Камчатка',
        description: 'В полёте видно озеро в кратере Малого Семячика.' }),
      // Медведи и киты — только в программе.
      row(40, { title: 'Камчатка за восемь дней', activity_type: 'sightseeing', operator_name: 'Лагуна Экспедиция',
        program_text: 'День 2. Морская прогулка Вероятность встречи с косатками и китами. День 4. Наблюдение за медведями на Курильском озере.' }),
      row(33, { title: 'Птичьи базары', activity_type: 'boat_trip', operator_name: 'Андрей Запорожец',
        description: 'Наблюдение за птицами у скал.' }),
      // Основа совпадает с НАЧАЛОМ слова: «кит» — не «Никита», «пеш» — не «успешно».
      row(90, { title: 'Морская прогулка с капитаном', activity_type: 'boat_trip', operator_name: 'Андрей Запорожец',
        description: 'Ведёт капитан Никита, рейсы успешно идут с 2015 года.' }),
    ]);
  });

  it('«вулкан»: тип, главное место-вулкан в (б), «Домашние вулканы» описания в (в); компания «Край Вулканов» — нигде', () => {
    const out = filter(cat, 'вулкан');
    const b = blocks(out);
    expect(b.typed).toEqual(['ID46']);
    expect(b.near).toEqual(['ID70']);
    expect(b.far).toEqual(['ID98']);
    expect(out).not.toMatch(/^ID4[47]:/m);
  });

  it('«экспедиция»: туры компании «Лагуна Экспедиция» не находятся, «джип-экспедиция» и «Экспедиционный» — находятся', () => {
    const out = filter(cat, 'экспедиция');
    expect(ids(out)).toEqual(inCatalogOrder(cat, [44, 65]));
  });

  it('служебный текст строки не совпадает: «заявка», «детали» — «нет», а не весь каталог как найденное', () => {
    // В каждой строке есть «заявки оператору» и «[есть детали…]».
    expect(cat.text.match(/заявки оператору/g)?.length).toBe(12);
    for (const w of ['заявка', 'детали', 'свободные']) {
      expect(filter(cat, w)).toMatch(new RegExp(`^Туров «${w}» у операторов платформы сейчас нет`));
    }
  });

  it('имя компании — «нет» с отсылкой к get_tour_details, а не её туры', () => {
    const out = filter(cat, 'Край Вулканов');
    expect(out).toMatch(/^Туров «Край Вулканов» у операторов платформы сейчас нет/);
    expect(out).toContain(NO_SELLER_NAMES);
  });

  it('оговорка об именах продавцов — и там, где туры нашлись, а не только в «нет»', () => {
    for (const w of ['вулкан', 'озеро', 'медведи', 'байдарки']) expect(filter(cat, w)).toContain(NO_SELLER_NAMES);
  });

  it('«озеро»: главное место типа «Озеро» — в (б); слово только в описании или программе — в (в), ниже (б)', () => {
    const out = filter(cat, 'озеро');
    const b = blocks(out);
    expect(b.near).toEqual(['ID81']);
    expect(b.far).toEqual(inCatalogOrder(cat, [54, 40]));
    expect(out.indexOf('ID81:')).toBeLessThan(out.indexOf(FAR_BLOCK_MARK));
  });

  it('«медведи» только в программе — в (в) с нейтральной подписью: что это, фильтр не знает', () => {
    const out = filter(cat, 'медведи');
    const b = blocks(out);
    expect(b.typed).toEqual(['ID47']);
    expect(b.far).toEqual(['ID40']);
    expect(out).toContain(`Слово «медведи» есть ${FAR_BLOCK_MARK} этих туров — занятие это, вид по пути или предупреждение, не проверено; get_tour_details прежде чем предлагать:`);
  });

  it('«байдарки»: «Тура с типом нет», тур со сравнением «похожие на байдарки» — только в (в); «ни в описаниях» нет', () => {
    const out = filter(cat, 'байдарки');
    expect(out).toMatch(/^Тура с типом «байдарки» нет; в названии, месте и кратком описании туров «байдарки» нет\./);
    expect(blocks(out).far).toEqual(['ID81']);
    expect(out).not.toContain('ни в описаниях');
    expect(out).not.toContain('у операторов платформы сейчас нет');
    expect(out).toContain('Порядок туров — правило платформы');
    expect(out).toContain('Когда турист спрашивает о конкретном туре');
  });

  it('правило «каждое слово» держится и в (в): «наблюдение за китами» не находит «наблюдение за птицами»', () => {
    const out = filter(cat, 'наблюдение за китами');
    expect(out).not.toContain('ID33:');
    expect(blocks(out).far).toEqual(['ID40']);
  });

  it('английское слово — словарём; незнакомая латиница — «не искал», а не «нет»', () => {
    // whales → «кит»: «китами» программы, но не «Никита»; hiking → «пеш» — не «успешно».
    expect(blocks(filter(cat, 'whales')).far).toEqual(['ID40']);
    expect(filter(cat, 'hiking')).toMatch(/^Туров «hiking» у операторов платформы сейчас нет/);
    expect(blocks(filter(cat, 'lake')).near).toEqual(['ID81']);
    const unknown = filter(cat, 'puffins');
    expect(unknown).toMatch(/^Тура с типом «puffins» нет\. По текстам туров «puffins» не искал: для «puffins» в словаре платформы нет русской основы/);
    expect(unknown).not.toContain('у операторов платформы сейчас нет');
    expect(filter(cat, 'сап')).toContain('не искал: в запросе нет слова от четырёх букв');
  });

  it('тур без указателя — проверен только тип, и это сказано; «нет» о нём не утверждается', () => {
    const partial = new Map(cat.entries);
    partial.delete('40');
    const out = filterTourCatalog(cat.text, 'медведи', { activityLabel, entries: partial });
    expect(out).toContain('У 1 туров указателя текстов нет — у них проверен только вид отдыха.');
    expect(blocks(out).far).toEqual([]);
  });

  it('предел блока (в) в чате: первые N по порядку каталога и строка «ещё M»', () => {
    const order = inCatalogOrder(cat, [54, 40]);
    const out = filter(cat, 'озеро', 1);
    expect(blocks(out).far).toEqual([order[0]]);
    expect(out).toContain('(Ещё 1 таких туров — get_tours с тем же activity_type и page=1 покажет все по страницам.)');
    expect(filter(cat, 'озеро')).not.toContain('(Ещё ');
  });
});

// Ревью 29.10 части 3: общие и короткие основы, четырёхбуквенные слова,
// подпись блока (в) у запроса из нескольких слов, пояснение (б) на страницах.
describe('get_tours: слова, которые ловят лишнее или теряют своё (ревью 29.10)', () => {
  let cat: TourCatalog;
  beforeAll(async () => {
    cat = await catalogOf([
      row(5, { title: 'Автомобильный тур на Курильское', activity_type: 'bears' }),
      row(6, { title: 'Тундра и ручьи', activity_type: 'trekking', description: 'Рекомендуем взять дождевик. Ночёвка в настоящей северной юрте.' }),
      row(7, { title: 'Кратер за 3 дня', activity_type: 'trekking', multi_day_count: 3, description: 'Туристы видят кратер с края.' }),
      row(8, { title: 'Два дня на реке', activity_type: 'rafting', short_description: 'спокойный сплав по реке' }),
      row(9, { title: 'Камчатка за восемь дней', activity_type: 'sightseeing', program_text: 'День 2. Морская прогулка Вероятность встречи с косатками и китами.' }),
      row(10, { title: 'Город и океан', activity_type: 'sightseeing', short_description: 'Горелый виден из города' }),
      // «Край» — в названии, «вулканы» — только в описании: фразы «край вулканов» нет.
      row(11, { title: 'На край света', activity_type: 'jeep_safari', description: 'По пути видны вулканы.' }),
      row(12, { title: 'Однодневный тур к подножию', activity_type: 'jeep_safari' }),
    ]);
  });

  it('«tours» и «day tour»: «тур» и «дн» не ищутся — ни «Туристы», ни «3 дня»; «day» — «однодневный»', () => {
    const tours = filter(cat, 'tours');
    expect(tours).toMatch(/^«tours» — общее слово/);
    const day = filter(cat, 'day tour');
    expect(ids(day.slice(0, day.indexOf('Когда турист')))).toEqual(['ID12']);
    expect(day).toContain('day → «однодневн…»');
  });

  it('«river»: «рек» — слово с окончанием («реке»), а не начало «Рекомендуем»', () => {
    const b = blocks(filter(cat, 'river'));
    expect(b.near).toEqual(['ID8']);
    expect(b.far).toEqual([]);
    expect(filter(cat, 'river')).toContain('river → «рек + окончание»');
  });

  it('короткая основа словаря — у каждой своё правило или названная причина, почему не ищется', () => {
    const short = [...new Set(Object.values(EN_TO_RU).flat().filter((st) => st.length < 4))];
    for (const st of short) expect(st in SHORT_STEMS || st in SHORT_STEMS_NOT_SEARCHED, st).toBe(true);
  });

  it('четырёхбуквенное слово — и с другим окончанием: «киты» — «китами», «юрта» — «юрте»; «горы» — не «город» и не «Горелый»', () => {
    expect(blocks(filter(cat, 'киты')).far).toEqual(['ID9']);
    expect(blocks(filter(cat, 'юрта')).far).toEqual(['ID6']);
    expect(filter(cat, 'горы')).toMatch(/^Туров «горы» у операторов платформы сейчас нет/);
    // «река» — «реке» и «реки», но не «Рекомендуем».
    expect(ids(filter(cat, 'река').split('Когда турист')[0])).toEqual(['ID8']);
  });

  it('несколько слов в (в): подпись — «по отдельности, не фразой», а не «слово есть в описании»', () => {
    const out = filter(cat, 'Край Вулканов');
    expect(blocks(out).far).toEqual(['ID11']);
    expect(out).toMatch(/^Ни у одного тура все слова «Край Вулканов» не стоят в названии, месте, кратком описании или главном месте\./);
    expect(out).toContain('Слова «Край Вулканов» есть в этих турах по отдельности, не фразой');
    expect(out).not.toContain('Слово «Край Вулканов» есть');
    expect(out).toContain(NO_SELLER_NAMES);
    // В (б) — так же: «реке» в названии, «спокойный» в кратком описании — не фраза.
    const near = filter(cat, 'река спокойная');
    expect(blocks(near).near).toEqual(['ID8']);
    expect(near).toContain(`Туры, где упоминается «река спокойная» (${NEAR_FIELDS}) — слова каждое отдельно, не обязательно фразой. Назови их`);
    expect(filter(cat, 'река')).not.toContain('не обязательно фразой');
  });

  it('пояснение (б) у названия места — только на страницах с его турами; страница одних (в) — без «Назови их»', async () => {
    const many = await catalogOf([
      row(20, { title: 'Озеро Пробное', activity_type: 'trekking' }),
      ...[21, 22, 23, 24, 25, 26, 27].map((n) => row(n, { title: `Маршрут ${n}`, activity_type: 'trekking', description: 'С перевала видно озеро Пробное.' })),
    ]);
    const out = filterTourCatalog(many.text, 'Пробное', { activityLabel, entries: many.entries });
    expect(blocks(out).near).toEqual(['ID20']);
    expect(blocks(out).far).toHaveLength(7);
    const pages = [1, 2].map((p) => paginateTourText(out, p));
    const nearPage = pages.find((p) => p.includes('ID20:')) as string;
    const farOnly = pages.find((p) => !p.includes('ID20:')) as string;
    expect(nearPage).toContain('Назови их');
    expect(farOnly).not.toContain('Назови их');
    expect(farOnly).toContain(FAR_BLOCK_MARK);
    // Шапка — на обеих.
    for (const p of pages) expect(p.startsWith('РЕАЛЬНЫЕ ТУРЫ')).toBe(true);
  });
});
