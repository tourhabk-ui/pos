// @vitest-environment node
/**
 * search_car_rental у Кузьмича, MCP и A2A — прокат машины БЕЗ водителя за
 * сутки (схема 1317, владелец 23.10 «пока берем аренду автомобилей и
 * трансфер»). Не трансфер (§14): перевозчик сдаёт машину с водителем целиком.
 *
 * Три исхода (§4.0): прайс есть — машины с ценой за сутки, залогом и
 * водителем; прокатчиков с прайсом нет — факт витрины словами; не смог
 * прочитать — «не смог проверить», без «проката нет». Фильтр query — по виду,
 * модели и «с водителем», без регистра и ё; пустой фильтр — «по запросу ничего
 * нет» и весь прайс, а не «проката нет». Телефон прокатчика в ответ не уходит.
 *
 * Сторож судит вызовом и текстом ответа, не исходником.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const loadMock = vi.fn();
// Загрузчик прайса подменён; чистое форматирование (rental-format) — настоящее.
vi.mock('@/lib/rental/rental', () => ({ loadRentalCompanies: (...a: unknown[]) => loadMock(...a) }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));
// core.ts тянет пул при импорте; инструменту проката база не нужна.
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { rentalAnswer, searchCarRentalForKuzmich } from '@/lib/kuzmich/car-rental-search';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { validateToolArgs, KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOLS, MCP_SERVER_INFO, TOOL_ENGLISH } from '@/lib/mcp/public-tools';
import type { RentalCompany, RentalOffer } from '@/lib/rental/rental-format';

const JIMNY: RentalOffer = {
  id: 'o1', title: 'Suzuki Jimny', bodyKind: 'suv', seats: 4, transmission: 'automatic', drive: '4wd', engineHp: 105,
  priceRubPerDay: 7000, priceIsFrom: false, depositRub: 15000, driver: 'self', conditions: null, sourceUrl: null, pricesSeenOn: '2026-10-23', photo: null,
};
const HIACE: RentalOffer = {
  id: 'o2', title: 'Toyota HiAce', bodyKind: 'minibus', seats: 12, transmission: 'automatic', drive: null, engineHp: null,
  priceRubPerDay: 12000, priceIsFrom: false, depositRub: null, driver: 'optional', conditions: null, sourceUrl: null, pricesSeenOn: null, photo: null,
};
const VAHTOVKA: RentalOffer = {
  id: 'o3', title: 'КамАЗ вахтовка', bodyKind: 'vahtovka', seats: null, transmission: 'manual', drive: '4wd', engineHp: null,
  priceRubPerDay: 35000, priceIsFrom: true, depositRub: 50000, driver: 'optional', conditions: null, sourceUrl: null, pricesSeenOn: null, photo: null,
};

const LAGUNA: RentalCompany = {
  partnerId: 'p1', slug: 'laguna-prokat', name: 'Лагуна Прокат', shortDescription: null, photos: [], logo: null,
  offers: [JIMNY, HIACE, VAHTOVKA],
  phone: '+79140000000', telegramHref: 'https://t.me/+79140000000',
};

const BASE = 'https://vedarai.ru';
/** Слова продажи места или трансфера — в ответе о прокате их быть не должно. */
const WRONG_GOODS = /за место|руб\/место|с водителем целиком/;

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  loadMock.mockReset();
  loadMock.mockResolvedValue([LAGUNA]);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('rentalAnswer: три исхода', () => {
  it('не смог проверить — «не смог», не «нет», с адресом витрины', () => {
    const out = rentalAnswer(null, undefined, BASE);
    expect(out).toMatch(/^Не смог проверить прайс проката/);
    expect(out).toMatch(/Не говори, что проката нет/);
    expect(out).toContain(`${BASE}/car-rental`);
    expect(out).not.toMatch(/пока нет/);
  });

  it('прокатчиков с прайсом нет — факт витрины словами, не сбой, не повод выдумывать', () => {
    const out = rentalAnswer([], 'внедорожник', BASE);
    expect(out).toMatch(/Прокатчиков с прайсом на платформе пока нет/);
    expect(out).toContain('не сбой');
    expect(out).toMatch(/не выдумывай/);
    expect(out).toContain(`${BASE}/car-rental`);
    expect(out).not.toMatch(/Не смог/);
  });

  it('прайс есть — машины строкой с ценой за сутки, «от», залогом, водителем; чего нет — не пишется', () => {
    const out = rentalAnswer([LAGUNA], undefined, BASE);
    expect(out).toMatch(/^Прокат — машина без водителя, цена за сутки за машину/);
    expect(out).toContain('Лагуна Прокат');
    expect(out).toContain('Suzuki Jimny — внедорожник, 4 места, автомат, 4WD, 105 л.с.: 7000 руб за сутки, залог 15000 руб, без водителя');
    // Залога и привода у HiAce не записано — про них ни слова, а не «0 руб».
    expect(out).toContain('Toyota HiAce — микроавтобус, 12 мест, автомат: 12000 руб за сутки, водитель по желанию, цена отдельно');
    expect(out).not.toMatch(/HiAce[^;]*залог/);
    // Цена «от» и ненаписанное число мест.
    expect(out).toContain('КамАЗ вахтовка — вахтовка, механика, 4WD: от 35000 руб за сутки, залог 50000 руб, водитель по желанию, цена отдельно');
    expect(out).not.toMatch(/вахтовка[^;]*мест/);
    expect(out).toContain(`на странице прокатчика: ${BASE}/car-rental/laguna-prokat`);
    // Что не записано — названо как неизвестное, а не придумано.
    expect(out).toMatch(/не записаны — уточняются у прокатчика/);
    expect(out).not.toMatch(/ |₽/);
    expect(out).not.toMatch(WRONG_GOODS);
  });

  it('телефон и мессенджер прокатчика в ответ модели не уходят — только ссылка на страницу (pd-guard)', () => {
    for (const out of [rentalAnswer([LAGUNA], undefined, BASE), rentalAnswer([LAGUNA], 'джип', BASE, { surface: 'mcp' })]) {
      expect(out).not.toMatch(/9140000000|\+7 ?914|t\.me|wa\.me/);
    }
  });

  it('на MCP заявка — create_car_rental_request, в чате инструмента заявки нет', () => {
    const mcp = rentalAnswer([LAGUNA], undefined, BASE, { surface: 'mcp' });
    expect(mcp).toMatch(/create_car_rental_request/);
    const chat = rentalAnswer([LAGUNA], undefined, BASE, { surface: 'chat' });
    expect(chat).toMatch(/инструмента заявки на прокат у агента нет/);
    expect(chat).not.toMatch(/request_\w+/);
  });
});

describe('rentalAnswer: фильтр query', () => {
  it('по виду — «джип» и «внедорожник» находят внедорожник, микроавтобус и вахтовку не показывают', () => {
    for (const q of ['джип', 'внедорожник', 'Внедорожник', 'кроссовер']) {
      const out = rentalAnswer([LAGUNA], q, BASE);
      expect(out, q).toContain('Suzuki Jimny');
      expect(out, q).not.toContain('Toyota HiAce');
      expect(out, q).not.toContain('КамАЗ');
      expect(out, q).not.toMatch(/ничего нет/);
    }
  });

  it('по модели — без регистра; «с водителем» — только машины, где водитель возможен; ё не мешает', () => {
    const model = rentalAnswer([LAGUNA], 'JIMNY', BASE);
    expect(model).toContain('Suzuki Jimny');
    expect(model).not.toContain('Toyota HiAce');

    const driver = rentalAnswer([LAGUNA], 'с водителем', BASE);
    expect(driver).toContain('Toyota HiAce');
    expect(driver).toContain('КамАЗ вахтовка');
    expect(driver).not.toContain('Suzuki Jimny');

    // «вездеход» через ё/е и регистр: у «Лагуны» вездехода нет — весь прайс с оговоркой.
    const yo = rentalAnswer([{ ...LAGUNA, offers: [{ ...JIMNY, bodyKind: 'offroad_truck', title: 'ТРЭКОЛ' }] }], 'ВЕЗДЕХОД', BASE);
    expect(yo).toContain('ТРЭКОЛ — вездеход');
    expect(yo).not.toMatch(/ничего нет/);
  });

  it('по запросу ничего — «в прайсе ничего нет» и весь прайс, а не «проката нет»', () => {
    const out = rentalAnswer([LAGUNA], 'квадроцикл', BASE);
    expect(out).toContain('По запросу «квадроцикл» в прайсе ничего нет; весь прайс:');
    expect(out).toContain('Suzuki Jimny');
    expect(out).toContain('Toyota HiAce');
    expect(out).not.toMatch(/Прокатчиков с прайсом на платформе пока нет|проката нет/);
  });

  it('у двух прокатчиков фильтр считается на каждом отдельно', () => {
    const second: RentalCompany = { ...LAGUNA, partnerId: 'p2', slug: 'vtoroy', name: 'Второй прокат', offers: [HIACE] };
    const out = rentalAnswer([LAGUNA, second], 'джип', BASE);
    expect(out).toContain('Лагуна Прокат. Suzuki Jimny');
    expect(out).toContain('Второй прокат. По запросу «джип» в прайсе ничего нет; весь прайс: Toyota HiAce');
  });
});

describe('rentalAnswer: кириллица и латиница — одно слово (23.10: «танк» не находил Tank-300)', () => {
  const TANK: RentalOffer = { ...JIMNY, id: 'o4', title: 'Tank-300', seats: 5, priceRubPerDay: 15000, depositRub: 30000 };
  const SEVER: RentalOffer = { ...VAHTOVKA, id: 'o5', title: 'Sever Truck', bodyKind: 'offroad_truck' };
  const CO: RentalCompany = { ...LAGUNA, offers: [JIMNY, HIACE, VAHTOVKA, TANK, SEVER] };

  it('марка по-русски находит латинское название: «танк» — Tank-300, «сузуки» и «джимни» — Suzuki Jimny', () => {
    const tank = rentalAnswer([CO], 'танк', BASE);
    expect(tank).toContain('Tank-300');
    expect(tank).not.toContain('Suzuki Jimny');
    expect(tank).not.toMatch(/ничего нет/);
    for (const q of ['сузуки', 'Джимни', 'сузуки джимни']) {
      const out = rentalAnswer([CO], q, BASE);
      expect(out, q).toContain('Suzuki Jimny');
      expect(out, q).not.toContain('Tank-300');
      expect(out, q).not.toMatch(/ничего нет/);
    }
  });

  it('неправильные написания — по таблице: «тойота», «хайс» — Toyota HiAce; «север трак» — Sever Truck', () => {
    for (const q of ['тойота', 'хайс', 'Тойота Хайс']) {
      const out = rentalAnswer([CO], q, BASE);
      expect(out, q).toContain('Toyota HiAce');
      expect(out, q).not.toContain('Tank-300');
    }
    const sever = rentalAnswer([CO], 'север трак', BASE);
    expect(sever).toContain('Sever Truck');
    expect(sever).not.toContain('КамАЗ');
  });

  it('латиницей про русское название: «kamaz» находит «КамАЗ вахтовка»; чужое слово по-прежнему «ничего нет»', () => {
    const out = rentalAnswer([CO], 'kamaz', BASE);
    expect(out).toContain('КамАЗ вахтовка');
    expect(out).not.toContain('Tank-300');
    expect(rentalAnswer([CO], 'танк джимни', BASE)).toContain('в прайсе ничего нет');
  });
});

describe('searchCarRentalForKuzmich: загрузчик и отказ', () => {
  it('прайс прочитан — ответ с машинами и адресом страницы прокатчика', async () => {
    // Момент после паузы проката на сайте (lib/rental/site-pause): здесь судится путь загрузчика, а не пауза.
    const out = await searchCarRentalForKuzmich({ query: 'джип' }, { now: new Date('2026-11-01T00:00:00Z') });
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(out).toContain('Suzuki Jimny');
    expect(out).toContain('https://vedarai.ru/car-rental/laguna-prokat');
  });

  it('прайс не прочитался — «не смог проверить», без «нет», имя проверки и SQLSTATE в логе, без ПД', async () => {
    loadMock.mockRejectedValue(Object.assign(new Error('relation "car_rental_offers" does not exist'), { code: '42P01' }));
    const out = await searchCarRentalForKuzmich({});
    expect(out).toMatch(/Не смог проверить прайс проката/);
    expect(out).toMatch(/Не говори, что проката нет/);
    expect(out).not.toMatch(/пока нет/);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0].map(String).join(' ');
    expect(logged).toContain('[car-rental-search]');
    expect(logged).toContain('42P01');
    expect(logged).not.toMatch(/9140000000|\+7 ?914/);
  });
});

describe('исполнитель Кузьмича и реестр', () => {
  it('executeKuzmichTool(search_car_rental) доходит до прайса проката на поверхности MCP', async () => {
    const out = await executeKuzmichTool('search_car_rental', { query: 'джип' }, { surface: 'mcp' });
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(out).toContain('Suzuki Jimny');
    expect(out).not.toContain('Toyota HiAce');
    expect(out).toMatch(/create_car_rental_request/);
  });

  it('схема: необязательные query, type и даты, лишние поля отброшены, у Кузьмича и MCP одна русская часть', () => {
    const kuzmich = KUZMICH_TOOLS.find((t) => t.function.name === 'search_car_rental')!;
    expect(Object.keys(kuzmich.function.parameters.properties)).toEqual(['query', 'type', 'date_from', 'date_to']);
    expect(kuzmich.function.parameters.required).toEqual([]);
    expect(validateToolArgs('search_car_rental', { query: 'джип', seats: '4', date: '2026-10-30' })).toEqual({ ok: true, args: { query: 'джип' } });
    expect(validateToolArgs('search_car_rental', {})).toEqual({ ok: true, args: {} });
    for (const description of [kuzmich.function.description]) {
      expect(description).toMatch(/БЕЗ водителя/);
      expect(description).toMatch(/за сутки/);
      expect(description).toContain('search_transfers');
      expect(description).not.toMatch(/за место|паспорт|email|почт[аы]|телефон туриста/i);
    }
  });

  it('наружу: в PUBLIC_MCP_TOOLS с английским слоем, только чтение; версия сервера равна server.json', () => {
    const mcp = PUBLIC_MCP_TOOLS.find((t) => t.name === 'search_car_rental')!;
    expect(mcp).toBeDefined();
    expect(mcp.title).toBe('Car rental');
    expect(mcp.description.startsWith(`${TOOL_ENGLISH.search_car_rental.lead} `)).toBe(true);
    expect(TOOL_ENGLISH.search_car_rental.lead).toMatch(/\bKamchatka\b/);
    expect(TOOL_ENGLISH.search_car_rental.lead).toContain('search_transfers');
    expect(mcp.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys((mcp.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(['query', 'type', 'date_from', 'date_to']);
    const manifest = JSON.parse(readFileSync('server.json', 'utf-8')) as { version: string };
    expect(manifest.version).toBe(MCP_SERVER_INFO.version);
    expect(MCP_SERVER_INFO.description).toMatch(/прокат машин/);
  });
});

describe('search_car_rental: слова просьбы, вид и даты (23.10)', () => {
  it('«аренда внедорожника» и «rent a car 4x4» находят джип, а не «ничего нет»', () => {
    for (const q of ['аренда внедорожника', 'rent a car 4x4', 'car rental SUV', 'прокат джипа']) {
      const text = rentalAnswer([LAGUNA], q, BASE, { surface: 'mcp' });
      expect(text, q).toContain('Suzuki Jimny');
      expect(text, q).not.toContain('ничего нет');
      expect(text, q).not.toContain('Toyota HiAce');
    }
  });
  it('type=minibus отбирает микроавтобус; даты дают сутки, сумму за них прайс не считает', () => {
    const text = rentalAnswer([LAGUNA], undefined, BASE, { surface: 'mcp' }, { type: 'minibus', date_from: '2026-11-10', date_to: '2026-11-14' });
    expect(text).toContain('Toyota HiAce');
    expect(text).not.toContain('Suzuki Jimny');
    expect(text).toContain('5 сут.');
    expect(text).toContain('12000 руб за сутки');
    expect(text).not.toContain('60000');
    expect(text).toContain('подтверждает прокатчик');
  });
  it('кривые даты и чужой type не ломают вызов', () => {
    expect(validateToolArgs('search_car_rental', { type: 'tank', date_from: 'завтра' }).ok).toBe(true);
  });
});
