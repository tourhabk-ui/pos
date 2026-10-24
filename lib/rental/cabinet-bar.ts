/**
 * Строка кнопок кабинета прокатчика: одна и та же под каждым ответом
 * кабинета в MAX и Telegram. Туристу и администратору её нет.
 *
 * Нажатие — короткий payload `rk:`. Чат и роль берутся из привязки,
 * не из кнопки. «Мои машины» и «Календарь» зовут уже существующие
 * чтения прайса и календаря; «Заявки» — список с «Беру» / «Не могу»;
 * «Правки» — черновики на модерации; «Помощь» — справка без цен.
 */

export interface CabinetButton {
  text: string;
  payload: string;
  intent?: 'positive' | 'negative';
}

export type RentalCabinetAction = 'fleet' | 'calendar' | 'requests' | 'edits' | 'help';

const BAR: ReadonlyArray<{ text: string; payload: string; action: RentalCabinetAction }> = [
  { text: 'Мои машины', payload: 'rk:fleet', action: 'fleet' },
  { text: 'Календарь', payload: 'rk:cal', action: 'calendar' },
  { text: 'Заявки', payload: 'rk:req', action: 'requests' },
  { text: 'Правки', payload: 'rk:edit', action: 'edits' },
  { text: 'Помощь', payload: 'rk:help', action: 'help' },
];

const BY_PAYLOAD = new Map(BAR.map((b) => [b.payload, b.action]));

export function rentalCabinetBar(): CabinetButton[] {
  return BAR.map((b) => ({ text: b.text, payload: b.payload }));
}

/** Последняя строка уже эта — вторую не клеим. */
export function withRentalCabinetBar(rows: CabinetButton[][]): CabinetButton[][] {
  const bar = rentalCabinetBar();
  const last = rows[rows.length - 1];
  if (last && last.length === bar.length && last.every((b, i) => b.payload === bar[i]?.payload)) return rows;
  return [...rows, bar];
}

export function parseRentalCabinetPress(payload: string): RentalCabinetAction | null {
  return BY_PAYLOAD.get(payload) ?? null;
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
}

/**
 * Текст кнопки и короткие команды того же действия.
 * «покажи машины», «автопарк», «календарь Jimny», «цена …» сюда не входят:
 * их уже разбирают прежние команды.
 */
export function rentalCabinetAsk(text: string): RentalCabinetAction | null {
  switch (norm(text)) {
    case 'мои машины':
      return 'fleet';
    case 'календарь':
      return 'calendar';
    case 'заявки':
    case 'мои заявки':
    case 'список заявок':
      return 'requests';
    case 'правки':
    case 'мои правки':
      return 'edits';
    case 'помощь':
    case 'справка':
      return 'help';
    default:
      return null;
  }
}

export function telegramCabinetMarkup(content: CabinetButton[][] = []): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: withRentalCabinetBar(content).map((row) => row.map((b) => ({
      text: b.text,
      callback_data: b.payload,
    }))),
  };
}

/** Справка. Цен нет: их называет прайс, не этот текст. */
export function rentalCabinetHelp(): string {
  return [
    'Кабинет проката. Под ответом одни и те же кнопки:',
    'Мои машины — ваш прайс: цена за сутки, залог, видна ли строка.',
    'Календарь — 30 дней вперёд. День без отметки — это не «свободна».',
    'Заявки — заявки с «Беру» и «Не могу». «Беру» отмечает эти дни занятыми и не закрепляет машину на сайте.',
    'Правки — черновики цены и описания, которые ждут одобрения. До одобрения на сайте прежняя строка.',
    'Оплата через платформу не принимается: расчёт с вами напрямую.',
    'Новую цену или описание напишите отдельным сообщением. Цена: слово «цена», название как в списке, рубли одним числом. Описание: слово «описание», название, двоеточие и текст. Фото эта команда не меняет.',
  ].join('\n');
}
