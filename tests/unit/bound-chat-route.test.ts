/**
 * Привязанный чат оператора и администратора (24.10): «найди мне в аренду
 * автомобиль» ушло помощнику CRM, и тот отказал в аренде. Просьба туриста
 * идёт Кузьмичу туриста. Кабинет — CRM, свои туры, прайс, календарь, правка
 * цены, открытие дат — остаётся помощнику. Неузнанное тоже остаётся кабинету.
 */
import { describe, expect, it } from 'vitest';
import {
  boundChatContext, boundChatLane, boundChatLaneFor, clearBoundChatEmergencies, partnerHasRental,
} from '@/lib/kuzmich/bound-chat-route';

const tourist = [
  'найди мне в аренду автомобиль',
  'Найди мне в аренду автомобиль',
  'хочу арендовать джип',
  'аренда автомобиля',
  'rent a car',
  'сколько стоит аренда машины',
  'подбери тур на Авачинский',
  'какие туры есть',
  'хочу забронировать тур',
  'нужен трансфер из аэропорта',
  'машина с водителем до Елизово',
  'спланируй поездку на 5 дней',
  'план поездки на неделю',
];

const partner = [
  '',
  'как дела',
  'кто ждёт ответа?',
  'найди Анну',
  'запиши, что звонил',
  'напомни перезвонить завтра',
  'покажи брони',
  'брони',
  'мои туры',
  'покажи машины',
  'мои машины',
  'автопарк',
  'прайс',
  'календарь',
  'заявки',
  'список заявок',
  'правки',
  'мои правки',
  'помощь',
  'справка',
  'календарь Jimny',
  'цена Jimny 8500',
  'описание Jimny: без скрытых платежей',
  'открой субботы июля, 8 мест',
  'отмена',
  '8',
  'следующая заявка',
  '/сводка',
  // Своё — «у меня», «у нас» и правка своего (проверка качества 24.10, #2756).
  'какие туры у меня завтра',
  'что у нас на выходные',
  'сколько стоит аренда у меня',
  'хочу поменять цену тура',
  'исправить описание тура',
];

// Прокатчик о своих машинах: свободна ли, на какую дату. У оператора без
// проката те же слова — просьба туриста (ему самому нужна машина).
const rentalCabinet = [
  'какой джип свободен 30 октября',
  'какие машины свободны на выходные',
  'хочу джип на 30 октября',
];

// Беда (проверка качества 24.10): у помощника CRM нет блока 112, а
// администратору бот отвечал «Не понял команду». Признаки — те же, что
// ставят блок 112 (lib/safety/sos-detector).
const emergency = [
  'Помогите, мы заблудились',
  'помогите',
  'турист сломал ногу',
  'SOS',
  'человек без сознания',
  'Спасите, медведь рядом с лагерем',
  'группа не вернулась с маршрута',
];

// Беда со словом CRM остаётся кабинетом: блок 112 ставит сам кабинет поверх
// ответа (operator-chat, admin-chat).
const emergencyWithCrm = [
  'запиши: у клиента сломана нога',
  'запиши: турист сломал ногу',
  'напомни перезвонить: человек без сознания',
];

// Команда кабинета своей формой остаётся кабинетом и с бедой в той же фразе
// (проверка качества 24.10): блок 112 над ответом ставит отправитель ответа
// кабинета. «Дизель не замерзает» — описание машины, а не беда.
const cabinetCommandWithEmergency = [
  'описание Toyota Hilux: дизель зимой не замерзает',
  'описание Toyota Hilux: если турист сломал ногу, довезём до травмпункта',
  'календарь Jimny',
  'календарь Jimny турист упал с обрыва',
  'покажи брони, где туристы с травмами',
];

describe('привязанный чат: просьба туриста отдельно от кабинета', () => {
  it.each(tourist)('турист: %s', (text) => {
    expect(boundChatLane(text)).toBe('tourist');
  });

  it.each(partner)('кабинет: %s', (text) => {
    expect(boundChatLane(text)).toBe('partner');
  });
});

describe('привязанный чат: беда', () => {
  it.each(emergency)('беда — Кузьмичу туриста: %s', (text) => {
    expect(boundChatLane(text)).toBe('tourist');
  });

  it.each(emergencyWithCrm)('беда с делом CRM — кабинет: %s', (text) => {
    expect(boundChatLane(text)).toBe('partner');
  });

  it.each(cabinetCommandWithEmergency)('команда кабинета своей формой — кабинет и с бедой: %s', (text) => {
    expect(boundChatLane(text)).toBe('partner');
  });
});

describe('привязанный чат прокатчика: свои машины — кабинет', () => {
  it.each(rentalCabinet)('прокатчик — кабинет: %s', (text) => {
    expect(boundChatLane(text, { rental: true })).toBe('partner');
  });

  it.each(rentalCabinet)('оператор без проката — Кузьмичу туриста: %s', (text) => {
    expect(boundChatLane(text)).toBe('tourist');
  });

  it('аренда без даты и без «свободен» у прокатчика — по-прежнему просьба туриста', () => {
    expect(boundChatLane('найди мне в аренду автомобиль', { rental: true })).toBe('tourist');
  });

  it('«у нас беда» — беда, хотя «у нас» — признак своего', () => {
    expect(boundChatLane('у нас беда, турист упал')).toBe('tourist');
    expect(boundChatLane('у нас беда')).toBe('tourist');
  });

  it('беда у прокатчика — Кузьмичу туриста и с машиной и датой', () => {
    expect(boundChatLane('джип перевернулся 30 октября, есть пострадавшие', { rental: true })).toBe('tourist');
  });

  it('прокат — пилот кабинета или категория «машины»', () => {
    expect(partnerHasRental({ slug: 'laguna-prokat', category: 'operator' })).toBe(true);
    expect(partnerHasRental({ slug: 'other', category: 'cars' })).toBe(true);
    expect(partnerHasRental({ slug: 'mestechko', category: 'operator' })).toBe(false);
    expect(partnerHasRental({ slug: null, category: 'transfer' })).toBe(false);
  });
});

// Проверка каналов 25.10: «хочу/нужно» и «тур» звучат как просьба туриста, а
// это даты своего тура — туроператору отвечал Кузьмич туриста.
describe('привязанный чат туроператора: даты своего тура — кабинет', () => {
  const datesAsks = ['нужно добавить даты тура на ноябрь', 'хочу выставить тур на 5 ноября, 8 мест'];
  it.each(datesAsks)('туроператор — кабинет: %s', (text) => {
    expect(boundChatLane(text, { ownTours: true })).toBe('partner');
  });
  it.each(datesAsks)('не туроператор — как раньше: %s', (text) => {
    expect(boundChatLane(text)).toBe('tourist');
  });
  it.each(['хочу забронировать тур на 15 июля', 'подбери тур на 5 ноября', 'спланируй поездку на 5 дней в июле'])(
    'просьба туриста у туроператора остаётся Кузьмичу туриста: %s', (text) => {
      expect(boundChatLane(text, { ownTours: true })).toBe('tourist');
    },
  );
  it('беда с датами — Кузьмичу туриста и у туроператора', () => {
    expect(boundChatLane('турист сломал ногу, закрой субботу', { ownTours: true })).toBe('tourist');
  });
  it('контекст по карточке: оператор, прокат, остальные', () => {
    expect(boundChatContext({ category: 'operator', slug: 'vulkan-tur' })).toEqual({ rental: false, ownTours: true });
    expect(boundChatContext({ category: 'transfer', slug: 'laguna-prokat' })).toEqual({ rental: true, ownTours: false });
    expect(boundChatContext({ category: 'guide', slug: null })).toEqual({ rental: false, ownTours: false });
  });
});

// 29.10: гид продаёт свои туры (1338). Его «нужно добавить даты тура на
// ноябрь» — дело его кабинета (сводка и расписание у помощника), а не
// просьба туриста. Гид команды оператора без своих туров — как раньше.
describe('привязанный чат гида: даты своего тура — кабинет, если туры его', () => {
  const datesAsks = ['нужно добавить даты тура на ноябрь', 'хочу выставить тур на 5 ноября, 8 мест'];
  const seller = boundChatContext({ category: 'guide', slug: null, sellsTours: true });
  const team = boundChatContext({ category: 'guide', slug: null, sellsTours: false });
  const unknown = boundChatContext({ category: 'guide', slug: null });

  it('признак продавца — только у гида со своими турами', () => {
    expect(seller).toEqual({ rental: false, ownTours: true });
    expect(team).toEqual({ rental: false, ownTours: false });
    expect(unknown).toEqual({ rental: false, ownTours: false });
    // Поле «продаёт» у перевозчика и жилья ничего не меняет.
    expect(boundChatContext({ category: 'transfer', slug: null, sellsTours: true }).ownTours).toBe(false);
    expect(boundChatContext({ category: 'stay', slug: null, sellsTours: true }).ownTours).toBe(false);
  });
  it.each(datesAsks)('гид-продавец — кабинет: %s', (text) => {
    expect(boundChatLane(text, seller)).toBe('partner');
  });
  it.each(datesAsks)('гид команды — как раньше, Кузьмичу туриста: %s', (text) => {
    expect(boundChatLane(text, team)).toBe('tourist');
    expect(boundChatLane(text, unknown)).toBe('tourist');
  });
  it.each(['хочу забронировать тур на 15 июля', 'подбери тур на 5 ноября'])(
    'просьба туриста у гида-продавца остаётся Кузьмичу туриста: %s', (text) => {
      expect(boundChatLane(text, seller)).toBe('tourist');
    },
  );
  it('беда с датами у гида-продавца — Кузьмичу туриста', () => {
    expect(boundChatLane('турист сломал ногу, закрой субботу', seller)).toBe('tourist');
  });
  it('вход с памятью беды (MAX, Telegram) передаёт признак дальше', () => {
    clearBoundChatEmergencies();
    expect(boundChatLaneFor('max', 4242, 'нужно добавить даты тура на ноябрь', seller)).toBe('partner');
    expect(boundChatLaneFor('telegram', 4242, 'нужно добавить даты тура на ноябрь', seller)).toBe('partner');
    expect(boundChatLaneFor('max', 4243, 'нужно добавить даты тура на ноябрь', team)).toBe('tourist');
  });
});
