/**
 * Постоянная клавиатура гида в Telegram (слово владельца 30.10: «это нужно
 * делать кнопками всё», «да, причём ux/ui»).
 *
 * У туроператора клавиатура внизу экрана есть с 25.10 (lib/telegram/operator-desk),
 * у гида — только строка под ответами и команды чата. Строка уезжает вверх с
 * каждым новым сообщением, и чтобы снова открыть «Входящие», гиду в поле
 * приходилось листать чат или набирать слово. Клавиатура стоит на месте.
 *
 * Кнопки клавиатуры — те же кнопки, что строка меню и «Ещё» этой карточки
 * (`partnerMenu`, `partnerMenuExtras`), а не второй список: подпись и действие
 * берутся оттуда. Поэтому кнопки без экрана здесь не бывает, и наоборот, —
 * та же связка, что у команд чата (lib/telegram/role-commands).
 *
 * Раскладка — по частоте: что ждёт ответа — первым, рядом брони; задачи и
 * клиенты; туры и «Ещё» — последним рядом. По две в ряд, чтобы попадать
 * пальцем. «Помощь» живёт в «Ещё»: справка нужна раз, а место на экране —
 * всегда. Гиду команды без своих туров — четыре вкладки строки.
 *
 * Только Telegram: у MAX постоянной клавиатуры нет, там кнопки под
 * сообщениями. Имён и телефонов в подписях нет.
 */

import {
  parseRoleMenuPress, partnerMenu, partnerMenuExtras, guideSellsOwnTours,
  type MenuAction, type MenuPartner,
} from '@/lib/roles/role-menu';
import type { MenuButton } from '@/lib/roles/chat-menu';

/** Порядок на клавиатуре — по действию; чего у карточки нет, того нет и здесь. */
const KEYBOARD_ORDER: readonly MenuAction[] = ['inbox', 'bookings', 'tasks', 'clients', 'tours', 'more'];

/** Кнопки клавиатуры этой карточки гида — из её строки и «Ещё»; не гид — пусто. */
function keyboardButtons(partner: MenuPartner): MenuButton[] {
  if (partner.category !== 'guide') return [];
  const all = [...(partnerMenu(partner) ?? []), ...partnerMenuExtras(partner)];
  const byAction = new Map<MenuAction, MenuButton>();
  for (const b of all) {
    const press = parseRoleMenuPress(b.payload);
    if (press && press.role === 'guide') byAction.set(press.action, b);
  }
  return KEYBOARD_ORDER.flatMap((a) => {
    const b = byAction.get(a);
    return b ? [b] : [];
  });
}

/** Ряды клавиатуры по две кнопки. */
export function guideKeyboardRows(partner: MenuPartner): string[][] {
  const labels = keyboardButtons(partner).map((b) => b.text);
  const rows: string[][] = [];
  for (let i = 0; i < labels.length; i += 2) rows.push(labels.slice(i, i + 2));
  return rows;
}

export interface ReplyKeyboardMarkup {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard: boolean;
  is_persistent: boolean;
  input_field_placeholder?: string;
}

/** Поле ввода нужно гиду для фамилии клиента и причины отказа — подсказка об этом. */
export const GUIDE_INPUT_PLACEHOLDER = 'Кнопки кабинета — ниже';

export function guideReplyMarkup(partner: MenuPartner): ReplyKeyboardMarkup {
  return {
    keyboard: guideKeyboardRows(partner).map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: GUIDE_INPUT_PLACEHOLDER,
  };
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/**
 * Нажатая кнопка клавиатуры — её действие. Клавиатура шлёт подпись текстом,
 * поэтому сравнение точное (без регистра и «ё»): «брони на завтра» и «покажи
 * мои туры» — не кнопка, а вопрос помощнику, как раньше.
 */
export function guideKeyboardAction(text: string, partner: MenuPartner): MenuAction | null {
  const t = norm(text);
  if (t === '') return null;
  for (const b of keyboardButtons(partner)) {
    if (norm(b.text) === t) return parseRoleMenuPress(b.payload)?.action ?? null;
  }
  return null;
}

/** Что делает кнопка — одной строкой приветствия. */
const KEY_LINE: Readonly<Partial<Record<MenuAction, string>>> = {
  inbox: 'что ждёт вашего ответа: брони, заявки, приглашения и отзывы',
  bookings: 'ждут ответа и ближайшие',
  tasks: 'сколько открытых задач и ближайший срок',
  clients: 'сколько клиентов в CRM и ссылка в кабинет',
  tours: 'ваши туры и открытые даты',
  more: 'ежедневная сводка, помощь и кабинет на сайте',
};

/**
 * Приветствие на /start вместе с клавиатурой: коротко, кнопка — строка.
 * Полная справка — «Помощь» в «Ещё». Называет ровно кнопки клавиатуры.
 */
export function guideStartText(partner: MenuPartner): string {
  const lines = ['<b>Кабинет гида в чате.</b> Кнопки внизу экрана:'];
  for (const b of keyboardButtons(partner)) {
    const action = parseRoleMenuPress(b.payload)?.action;
    const what = action ? KEY_LINE[action] : undefined;
    lines.push(what ? `«${b.text}» — ${what}.` : `«${b.text}».`);
  }
  lines.push('Имена и телефоны туристов и заголовки задач в Telegram не показываю — они в MAX.');
  if (guideSellsOwnTours(partner)) {
    lines.push('Ответить на бронь или заявку — кнопкой в её карточке во «Входящих»: бот переспросит, и ответ записывается только после «Да».');
    lines.push('Писать нужно только причину, когда отклоняете бронь: её получит турист.');
  }
  return lines.join('\n');
}
