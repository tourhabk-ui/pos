/**
 * Ошибка валидации — человеку, а не разработчику.
 *
 * Прогулка оператором 11.09 (#1797): при сохранении тура приходило
 * `Invalid option: expected one of "volcano"|"hot_spring"|…` — английский
 * текст со внутренними значениями enum, и он показывался оператору как есть.
 * CLAUDE.md §4: «Ошибки — понятные сообщения на русском».
 *
 * Здесь — перевод ПЕРВОГО отказа Zod в одну русскую фразу: имя поля словами
 * плюс что с ним не так. Полный список проблем не собирается намеренно:
 * форма подсвечивает поле, человеку нужна одна внятная причина, а не выгрузка
 * issue-объектов. Имени поля в карте нет — в ход идёт путь как есть: это
 * честнее выдуманного названия.
 */
import { z } from 'zod';

/** Имена полей, которые оператор и турист реально видят на формах. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Название',
  description: 'Описание',
  short_description: 'Краткое описание',
  location_type: 'Тип локации',
  activity_type: 'Тип активности',
  location_name: 'Место',
  latitude: 'Широта',
  longitude: 'Долгота',
  base_price: 'Цена',
  price_old: 'Старая цена',
  price_unit: 'Единица цены',
  max_participants: 'Максимум участников',
  min_participants: 'Минимум участников',
  duration_hours: 'Длительность, часов',
  duration_type: 'Тип длительности',
  multi_day_count: 'Число дней',
  season_start: 'Начало сезона',
  season_end: 'Конец сезона',
  difficulty: 'Сложность',
  included: 'Что включено',
  not_included: 'Что не входит',
  what_to_bring: 'Что взять с собой',
  photos: 'Фотографии',
  tour_image: 'Обложка',
  cancellation_policy: 'Условия отмены',
  pickup_type: 'Как турист попадает на тур',
  pickup_details: 'Детали подвоза',
  meeting_point: 'Точка сбора',
  booking_date: 'Дата тура',
  participants: 'Участников',
  tourist_name: 'Имя туриста',
  tourist_phone: 'Телефон',
  tourist_email: 'Почта',
  dates: 'Даты',
  date: 'Дата',
  available_slots: 'Свободных мест',
};

function fieldName(path: PropertyKey[]): string {
  const parts = path.filter((p) => typeof p === 'string') as string[];
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1];
  return FIELD_LABELS[last] ?? FIELD_LABELS[parts[0]] ?? parts.join('.');
}

function issueText(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'обязательно' : 'неверный тип значения';
    case 'invalid_value':
    case 'invalid_format':
      return 'значение не из допустимых';
    case 'too_small': {
      const min = (issue as { minimum?: unknown }).minimum;
      const origin = (issue as { origin?: string }).origin;
      if (origin === 'string') return `слишком коротко (минимум ${String(min)} символов)`;
      if (origin === 'array') return `нужно хотя бы ${String(min)}`;
      return `слишком мало (минимум ${String(min)})`;
    }
    case 'too_big': {
      const max = (issue as { maximum?: unknown }).maximum;
      const origin = (issue as { origin?: string }).origin;
      if (origin === 'string') return `слишком длинно (максимум ${String(max)} символов)`;
      if (origin === 'array') return `слишком много (максимум ${String(max)})`;
      return `слишком много (максимум ${String(max)})`;
    }
    default:
      return 'заполнено неверно';
  }
}

/**
 * Одна русская фраза по первому отказу. Кастомное сообщение схемы (если автор
 * его написал по-русски) сохраняется — оно точнее общего перевода.
 */
export function zodErrorMessage(error: z.ZodError, fallback = 'Проверьте заполнение полей'): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const custom = issue.message;
  const isCyrillic = /[А-Яа-яЁё]/.test(custom ?? '');
  const name = fieldName(issue.path as PropertyKey[]);
  if (isCyrillic) return name ? `${name}: ${custom}` : custom;
  const what = issueText(issue);
  return name ? `${name}: ${what}` : what;
}
