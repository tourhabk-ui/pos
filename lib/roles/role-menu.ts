/**
 * Меню роли в привязанном чате: одна строка под ответом кабинета.
 * Кнопка есть только там, где действие уже написано.
 *
 * Прокатчик пилота сюда не входит: у него своя строка `rk:`
 * (lib/rental/cabinet-bar). Агенту и снаряжению кнопку не рисуем:
 * у агента входящих нет, отдельного чтения для снаряжения в чате нет.
 *
 * Администратор — шесть чтений из lib/max/admin-read. Партнёр — кабинет в
 * чате (решение владельца 30.10, lib/chat-cabinet): «Входящие», «Задачи»,
 * «Клиенты», «Ещё». Остальное, что было в строке раньше, — в «Ещё»
 * (`partnerMenuExtras`): у пилота запросов мест «Сводка», у гида, который
 * продаёт свои туры (`sellsOwnTours`, 29.10), «Брони» и «Мои туры» — те же
 * чтения, что раздел «Свои туры» на сайте (lib/guides/chat-screens), у всех
 * — «Помощь». Прежние кнопки в старых сообщениях (`rm:gd:bk` и другие)
 * работают как раньше.
 */

import { getPublicBaseUrl } from '@/lib/config';
import { GUIDE_OWN_PATH } from '@/lib/partners/cabinet-links';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { summaryEnabledFor } from '@/lib/seat-requests/summary';
import type { MenuButton } from '@/lib/roles/chat-menu';

export type MenuRole = 'admin' | 'operator' | 'transfer' | 'stay' | 'guide';

export type MenuAction =
  | 'inbox' | 'summary' | 'dates' | 'bookings' | 'leads' | 'tours' | 'health' | 'help'
  | 'tasks' | 'clients' | 'more'
  /** «Занято» хозяина жилья (30.10): раздел кабинета в чате, lib/chat-cabinet. */
  | 'busy';

const ROLE_CODE: Record<MenuRole, string> = {
  admin: 'ad',
  operator: 'op',
  transfer: 'tf',
  stay: 'st',
  guide: 'gd',
};

const CODE_ROLE = new Map(Object.entries(ROLE_CODE).map(([role, code]) => [code, role as MenuRole]));

const ACTION_CODE: Record<MenuAction, string> = {
  inbox: 'in',
  summary: 'sm',
  dates: 'dt',
  bookings: 'bk',
  leads: 'ld',
  tours: 'tr',
  health: 'hl',
  help: 'hp',
  tasks: 'tk',
  clients: 'cl',
  more: 'mn',
  busy: 'bz',
};

const CODE_ACTION = new Map(Object.entries(ACTION_CODE).map(([action, code]) => [code, action as MenuAction]));

function button(role: MenuRole, action: MenuAction, text: string): MenuButton {
  return { text, payload: `rm:${ROLE_CODE[role]}:${ACTION_CODE[action]}` };
}

export function adminMenu(): MenuButton[] {
  return [
    button('admin', 'dates', 'Даты'),
    button('admin', 'bookings', 'Брони'),
    button('admin', 'leads', 'Заявки'),
    button('admin', 'summary', 'Сводка'),
    button('admin', 'health', 'Здоровье'),
    button('admin', 'help', 'Помощь'),
  ];
}

export interface MenuPartner {
  partnerId: string;
  category: string;
  slug?: string | null;
  /** `partners.user_id`. Нет аккаунта — непрочитанное чата кабинета не считается. */
  userId?: string | null;
  /**
   * Есть ли у карточки свои неудалённые туры — `findPartnerByChat` и
   * `bindPartnerChannel` читают его тем же запросом, что карточку. Решает
   * `sellsOwnTours`; поля нет — не продаёт.
   */
  sellsTours?: boolean;
}

/**
 * Окно «ближайших» броней в чате гида, дней. Одно число на экран «Брони»
 * (lib/guides/chat-screens) и справку, которая его называет. На сайте — все
 * предстоящие.
 */
export const CHAT_BOOKINGS_WINDOW_DAYS = 14;

/** Гид, который продаёт свои туры: у него в строке «Брони» и «Мои туры». */
export function guideSellsOwnTours(partner: MenuPartner): boolean {
  return partner.category === 'guide' && sellsOwnTours(partner);
}

/** null — этой записи меню роли нет (пилот проката, агент, снаряжение, чужая категория). Админ сюда не входит: его меню не из карточки партнёра. */
export function menuRoleOf(partner: MenuPartner): Exclude<MenuRole, 'admin'> | null {
  if (isRentalPilotSlug(partner.slug)) return null;
  if (
    partner.category === 'operator'
    || partner.category === 'transfer'
    || partner.category === 'stay'
    || partner.category === 'guide'
  ) return partner.category;
  return null;
}

/**
 * Строка партнёра — вкладки кабинета в чате. Кнопка шлёт раздел новым
 * сообщением (строка стоит и под уведомлениями — править их нельзя);
 * листать дальше — кнопками самого экрана (`cb:`), они правят его на месте.
 */
export function partnerMenu(partner: MenuPartner): MenuButton[] | null {
  const role = menuRoleOf(partner);
  if (!role) return null;
  // Хозяину жилья — две кнопки простыми словами (слово владельца 30.10:
  // хозяин «Кутхи» с мессенджером на «вы», «Входящие», «Задачи» и «Клиенты»
  // для него чужие слова). «Заявки» — те же «Входящие» кабинета в чате.
  // «Занято» — свои закрытые даты и кнопка открыть обратно; закрыть — фразой.
  if (role === 'stay') return [button(role, 'inbox', 'Заявки'), button(role, 'busy', 'Занято'), button(role, 'help', 'Помощь')];
  return [
    button(role, 'inbox', 'Входящие'),
    button(role, 'tasks', 'Задачи'),
    button(role, 'clients', 'Клиенты'),
    button(role, 'more', 'Ещё'),
  ];
}

/**
 * Что лежит в «Ещё» кнопками меню роли: сводка пилота, брони и туры гида со
 * своими турами, помощь. Туроператору «Мои туры и цены», «Обновить места» и
 * «Написать в поддержку» ставит экран «Ещё» (lib/chat-cabinet/screens) —
 * это кнопки его кабинета (`opd:`, `sup:`), а не меню роли.
 */
export function partnerMenuExtras(partner: MenuPartner): MenuButton[] {
  const role = menuRoleOf(partner);
  if (!role) return [];
  const out: MenuButton[] = [];
  if (role === 'operator' && summaryEnabledFor(partner.partnerId)) out.push(button(role, 'summary', 'Сводка'));
  if (guideSellsOwnTours(partner)) out.push(button(role, 'bookings', 'Брони'), button(role, 'tours', 'Мои туры'));
  out.push(button(role, 'help', 'Помощь'));
  return out;
}

export function parseRoleMenuPress(payload: string): { role: MenuRole; action: MenuAction } | null {
  const match = /^rm:([a-z]{2}):([a-z]{2})$/.exec(payload);
  if (!match) return null;
  const role = CODE_ROLE.get(match[1] ?? '');
  const action = CODE_ACTION.get(match[2] ?? '');
  if (!role || !action) return null;
  if (role === 'admin') {
    // У администратора нет «Входящих», «Моих туров» и кабинета в чате — только его шесть чтений.
    if (action === 'inbox' || action === 'tours' || action === 'tasks' || action === 'clients' || action === 'more') return null;
    return { role, action };
  }
  if (
    action === 'inbox' || action === 'summary' || action === 'help'
    || action === 'tasks' || action === 'clients' || action === 'more'
  ) return { role, action };
  // «Брони» и «Мои туры» — только у гида. Продаёт ли он свои туры, решает
  // экран по карточке чата, а не payload.
  if (role === 'guide' && (action === 'bookings' || action === 'tours')) return { role, action };
  // «Занято» — только у хозяина жилья: у остальных занятость считается иначе.
  if (role === 'stay' && action === 'busy') return { role, action };
  return null;
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
}

export type RoleAsk = 'inbox' | 'help' | 'tours' | 'seats' | 'tasks' | 'clients' | 'busy';

/** Точная фраза кнопки. «покажи входящие» и голое «заявки» сюда не входят. */
export function roleMenuAsk(text: string): RoleAsk | null {
  switch (norm(text)) {
    // Раздел «Занято» хозяина жилья; «занято с 5 по 9 ноября» — не сюда, а запись (lib/stay/busy-flow).
    case 'занято':
    case 'что занято':
    case 'когда занято':
    case 'занятость':
    case 'занятые даты':
      return 'busy';
    case 'входящие':
    case 'мои входящие':
    case 'новые заявки':
    case 'мои заявки':
      return 'inbox';
    case 'задачи':
    case 'мои задачи':
      return 'tasks';
    case 'клиенты':
    case 'мои клиенты':
      return 'clients';
    case 'мои туры и цены':
      return 'tours';
    case 'обновить места':
      return 'seats';
    case 'помощь':
    case 'справка':
      return 'help';
    default:
      return null;
  }
}

const ROLE_TITLE: Record<Exclude<MenuRole, 'admin'>, string> = {
  operator: 'Кабинет оператора',
  transfer: 'Кабинет перевозчика',
  stay: 'Кабинет жилья',
  guide: 'Кабинет гида',
};

const INBOX_LINE: Record<Exclude<MenuRole, 'admin'>, string> = {
  operator: 'Входящие — брони, запросы мест, заявки вам и отзывы, которые ждут ответа. Имени и телефона туриста в этом списке нет.',
  transfer: 'Входящие — заявки на машину, которые ждут вашего ответа: в карточке заявки кнопки «Беру» и «Не могу». Имени и телефона заказчика в этом списке нет.',
  stay: 'Заявки — гости, которые ждут вашего ответа: даты и сколько человек. Имя и телефон гостя — в самой заявке в MAX.',
  // Тот же список, что «Входящие» кабинета гида (INBOX_BY_CATEGORY.guide).
  guide: 'Входящие — брони, запросы мест и заявки на туры, которые вы продаёте сами, приглашения в команду и отзывы без ответа. Имени и телефона туриста в этом списке нет.',
};

/**
 * Справка кабинета в чате: вкладки строки и что лежит в «Ещё» у этой
 * карточки. Называет только то, что у неё есть. Цен и оплаты нет.
 */
/**
 * Справка хозяину жилья — простыми словами, по шагам (слово владельца 30.10).
 * Называет только то, что у него есть: заявка с тремя кнопками, напоминание,
 * переписка и звонок. Ни кабинета на сайте, ни «Задач», ни «Клиентов» — они
 * ему не нужны и в его строке кнопок их нет.
 */
export function stayMenuHelp(): string {
  return [
    'Как это работает:',
    '1. Гость оставляет заявку на сайте — вам приходит сообщение: даты, сколько человек, имя и телефон.',
    '2. Под сообщением три кнопки: «Свободно, беру», «Занято», «Позвоню сам». Нажмите одну — гость сразу получит ваш ответ. Больше ничего делать не нужно.',
    '3. Если за два часа ответа нет, бот напомнит одним сообщением с теми же кнопками.',
    '4. Когда у вас занято, напишите сюда одним сообщением: «занято с 5 по 9 ноября». Гости этих дат на сайте не выберут. Открыть обратно — «свободно с 5 по 9 ноября» или кнопка «Освободить» в разделе «Занято».',
    'Кнопки под ответами бота: «Заявки» — гости, которые ждут ответа; «Занято» — какие даты вы закрыли; «Помощь» — этот текст.',
    'Написать гостю своими словами — кнопка «Ответить гостю» под заявкой. Позвонить — телефон в заявке.',
    'Даты и цену вы подтверждаете сами, по телефону. Через Ведар оплаты нет.',
  ].join('\n');
}

export function partnerMenuHelp(role: Exclude<MenuRole, 'admin'>, partner: MenuPartner): string {
  if (role === 'stay') return stayMenuHelp();
  const extras = partnerMenuExtras(partner);
  const has = (code: string) => extras.some((b) => b.payload.endsWith(`:${code}`));
  const bookings = has('bk');
  const tours = has('tr');
  // Кнопки брони в чате — туроператору и гиду со своими турами (lib/bookings/chat-owner-press).
  const bookingButtons = role === 'operator' || bookings;
  const lines = [
    `${ROLE_TITLE[role]} в чате. Под ответами кнопки: Входящие, Задачи, Клиенты, Ещё.`,
    'Кнопки самого экрана листают кабинет в том же сообщении, а не присылают новое.',
    `${INBOX_LINE[role]} Номер в списке открывает карточку: кнопки ответа, звонок клиенту и напоминание себе.`,
    'Задачи — открытые, по сроку: «Готово» и «На завтра». В Telegram — только счёт: заголовки задач и имена клиентов — в MAX.',
    'Клиенты — свежие сверху и поиск по имени или 4 последним цифрам телефона; карточка — телефон, обращения, лента и кнопки звонка. Только в MAX.',
    `Ещё — ${[
      ...(role === 'operator' ? ['Мои туры и цены', 'Обновить места'] : []),
      ...(role === 'transfer' ? ['Машины и прайс', 'Сводка'] : []),
      // Гид без своих туров (31.10): «Мои туры» кабинета — там заводится первый тур.
      ...(role === 'guide' && !tours ? ['Мои туры'] : []),
      ...extras.map((b) => b.text),
      ...(role === 'operator' ? ['Написать в поддержку'] : []),
      'кабинет на сайте',
    ].join(', ')}.`,
  ];
  if (has('sm')) {
    lines.push('Сводка — числа по запросам мест: сколько ждут, без имени и телефона.');
  }
  if (bookings) {
    lines.push(`Брони — ждут вашего ответа и действующие на ближайшие ${CHAT_BOOKINGS_WINDOW_DAYS} дней. Имя и телефон туриста — только в MAX.`);
  }
  if (tours) {
    lines.push('Мои туры — ваши туры: на сайте или черновик и сколько открытых дат; там же новый тур и вывод тура на сайт и с сайта.');
  } else if (role === 'guide') {
    // Новый тур гида (31.10, lib/guides/tour-edit/create-*): черновик кнопкой, на сайт — сам гид.
    lines.push('Мои туры — своих туров пока нет: там заводится новый тур, черновиком; на сайт его выводите сами, когда хватает описания и цены.');
  }
  if (bookingButtons) {
    // Кнопки ответа брони — lib/bookings/chat-owner-action (29.10, шаг 6; туроператору — 30.10).
    lines.push(`В карточке ждущей брони${bookings ? ' и в «Бронях»' : ''} — «Подтвердить» и «Отклонить»${bookings ? ', под прошедшими — «Тур прошёл» и «Не пришёл»' : ''}: `
      + 'бот спросит, и бронь меняется только после «Да». Отклонение — с причиной одним сообщением, её получит турист.');
  }
  if (bookings) {
    // Кнопки ответа заявки — тот же модуль (29.10, шаг 7).
    lines.push('В карточке ждущей заявки — «Связался», «Договорились», «Отказ»: тоже после «Да», туристу ничего не уходит. '
      + '«Обсуждаем» — в кабинете.');
  }
  if (role === 'operator') {
    lines.push('В карточке заявки — «Принять», «Нет мест», «Уточнить», «Свяжусь сам»: ответ записывается сразу, бронь им не подтверждается.');
  }
  if (role === 'transfer') {
    // Парк и прайс в чате — #2862 этап C (lib/chat-cabinet fleetScreen, lib/transfers/price-edit-flow).
    lines.push('Машины и прайс — парк с кнопками «Снять с линии» и «Вернуть» и строки прайса с черновиками. '
      + 'Цену можно прислать фразой «цена Авачинский 65000»: это черновик, на сайт он попадёт после одобрения администратором. '
      + 'Примечание, условия и новая строка прайса — в кабинете на сайте.');
    // Сводка перевозчика — #2862 этап D (lib/transfers/carrier-summary): числа без имён, в оба канала.
    lines.push('Сводка — заявки на машину за 30 дней, сколько отвечено и сколько ждут, время первого ответа, поездки по вашему слову, отзывы и средняя. Без имён и телефонов.');
  }
  if (bookingButtons) {
    lines.push('Кнопки брони и заявки нажимает тот, кто подключил этот чат ссылкой из кабинета.');
  }
  if (bookings || tours) {
    // Даты словами — поток с кнопкой «Открыть» (lib/operators/chat-dates/flow,
    // гиду со своими турами — с 29.10); только в MAX и в личном диалоге.
    lines.push('Даты можно открыть фразой в личном диалоге с ботом в MAX, например «открой субботы июля, 8 мест»: '
      + 'бот покажет, что откроется, и откроет после кнопки «Открыть».');
    lines.push(`Открыть даты и всё о бронях и заявках — в кабинете, раздел «Свои туры»: ${getPublicBaseUrl()}${GUIDE_OWN_PATH}`);
    if (role === 'guide') {
      // Документ гида (.docx → поля тура, 1361, lib/guides/tour-edit/doc-flow).
      lines.push('Тексты тура можно прислать в MAX документом Word (.docx), первая строка — название тура в ёлочках: '
        + 'бот разложит разделы по полям тура, покажет по каждому, что было и что станет, и запишет только после кнопки — всё сразу или по полю.');
    }
  }
  if (role === 'guide') {
    // Роль гида, этап 2 (30.10, lib/guides/chat-role): у любого гида.
    lines.push('В «Ещё» у гида — «Расписание» (записи календаря и группы на 14 дней), «Заработок» (начисления за 30 дней), '
      + '«Профиль» (о себе, опыт, языки и команда оператора) и «Отзывы».');
    lines.push('Ответ на отзыв — кнопкой в карточке отзыва во «Входящих» или в «Отзывах»: текст следующим сообщением, бот покажет, '
      + 'что было и что станет, и опубликует только после кнопки. Свой ответ там же можно изменить или удалить. '
      + 'Приглашение в команду оператора — принять или отклонить кнопкой в его карточке; выйти из команды — в «Профиле», с подтверждением.');
    lines.push('Профиль правится фразой: о себе: …, опыт: 12, языки: русский, английский — запишется только после кнопки под предпросмотром.');
  }
  lines.push('Утром, если что-то ждёт ответа или подошёл срок задачи, бот пришлёт короткую сводку с этими кнопками.');
  lines.push('Помощь — этот текст.');
  lines.push('Оплата через платформу не принимается.');
  return lines.join('\n');
}

export function adminMenuHelp(): string {
  return [
    'Кабинет администратора. Под ответом те же кнопки:',
    'Даты — открытые даты туров витрины на 30 дней.',
    'Брони — ждут подтверждения оператора. Контакты туристов — только в MAX.',
    'Заявки — без ответа человека. Контакты — только в MAX.',
    'Сводка — посетители и ответы Кузьмича за сегодня и вчера.',
    'Здоровье — последний прогон сторожа платформы.',
    'Помощь — этот текст.',
    'Кнопок, которые сами подтверждают бронь или открывают даты, здесь нет.',
  ].join('\n');
}
