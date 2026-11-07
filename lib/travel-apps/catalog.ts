/**
 * Правила списка сторонних приложений в дорогу — без базы, чтобы их читали и
 * страницы в браузере (админка), и сервер (Кузьмич, /ai-tools). Чтение
 * таблицы — lib/agents/tools/taaft-search.ts.
 *
 * Это НЕ инструменты Ведара. Их делают другие компании; Кузьмич советует их
 * для узких задач, страница /ai-tools показывает списком (миграция 1396).
 *
 * Правила:
 *   - безопасность (SOS, обстановка, вулканы, погода) сторонним приложением
 *     не закрывается — ответ называет инструменты Ведара и 112;
 *   - определитель по фото подсказывает вид, а не съедобность — это сказано
 *     рядом с каждым таким приложением;
 *   - подбор под задачу не придумывает: ничего не подошло — так и сказано,
 *     и дан весь список (он короткий), а не «похожее» наугад.
 */

export interface ExternalTool {
  id: string;
  slug: string;
  name: string;
  description: string;
  url: string;
  category: string;
  tags: string[];
  is_free: boolean;
}

/** Разделы списка в порядке показа — по задаче, а не по «популярности». */
export const APP_CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'maps', label: 'Карты и треки' },
  { value: 'nature', label: 'Растения и животные по фото' },
];

export const NATURE_CAUTION =
  'Определитель по фото подсказывает вид, но не съедобность и не безопасность: грибы и ягоды по фото не проверяйте.';

export const SAFETY_POINTER =
  'Безопасность — не сторонние приложения: SOS, обстановка, вулканы и погода — инструменты Ведара, экстренный вызов — 112.';

/** Слова, которые есть почти в любой просьбе и ничего не говорят о задаче. */
const STOP_ROOTS = new Set([
  'прил', 'прог', 'серв', 'сайт', 'нужн', 'хочу', 'можн', 'како', 'чтоб', 'найт', 'есть',
  'посо', 'подс', 'скаж', 'дайт', 'пожа', 'этот',
]);

/**
 * Корни слов просьбы: слова от четырёх букв, первые четыре буквы. Грубая основа
 * для русского («карты» и «карте», «растение» и «растений» сходятся), и её
 * хватает на короткий список: ошибка подбора видна сразу, а промах честно
 * кончается всем списком.
 */
export function queryRoots(task: string): string[] {
  const words = task.toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]{4,}/g) ?? [];
  const roots = words.map((w) => w.slice(0, 4)).filter((r) => !STOP_ROOTS.has(r));
  return [...new Set(roots)];
}

/** Приложения, у которых в имени, описании или метках есть корень просьбы; больше совпадений — выше. */
export function matchApps(task: string, apps: ExternalTool[]): ExternalTool[] {
  const roots = queryRoots(task);
  if (roots.length === 0) return [];
  const scored = apps
    .map((app) => {
      const text = `${app.name} ${app.description} ${app.tags.join(' ')}`.toLowerCase().replace(/ё/g, 'е');
      return { app, score: roots.filter((r) => text.includes(r)).length };
    })
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name, 'ru'));
  return scored.map((x) => x.app);
}

function appLine(t: ExternalTool): string {
  return `• ${t.name}${t.is_free ? ' (бесплатно)' : ''}: ${t.description}\n  ${t.url}`;
}

/** Ответ инструмента Кузьмичу. Подошедшее — списком; не подошло — так и сказано, и дан весь список. */
export function formatAppsForKuzmich(matched: ExternalTool[], all: ExternalTool[]): string {
  const head = 'Сторонние приложения — их делают другие компании, Ведар за них не отвечает. Называй их сторонними и не выдавай за возможности Ведара; других приложений сверх этого списка не придумывай.';
  if (all.length === 0) return `${head}\n\nСписок сторонних приложений пуст.\n\n${SAFETY_POINTER}`;
  const shown = matched.length > 0 ? matched : all;
  const lead = matched.length > 0
    ? 'Под задачу подходят:'
    : `Под эту задачу в списке ничего нет. Весь список (${all.length}):`;
  const parts = [head, '', lead, shown.map(appLine).join('\n\n')];
  if (shown.some((t) => t.category === 'nature')) parts.push('', NATURE_CAUTION);
  parts.push('', SAFETY_POINTER);
  return parts.join('\n');
}
