/**
 * SSR-сторож (шаг 4 аудита 11.07): проверяет, что публичные листинги отдают
 * контент в ПЕРВОМ HTML — то, что починил шаг 3 (#457/#460/#461). Регрессия
 * здесь тихая: рефакторинг молча возвращает клиентский рендер, страницы
 * «работают», а трафик проседает через месяц. Сторож ловит это за неделю.
 *
 * Чистые функции без сети/БД — сетевую часть делает cron-роут.
 */

export interface SsrProbe {
  /** Человекочитаемое имя пробы для алерта. */
  name: string;
  /** Путь на проде. */
  path: string;
  /** Проверка первого HTML: ok=false — SSR-контент пропал. */
  check: (html: string) => { ok: boolean; detail: string };
}

function countOf(html: string, needle: string | RegExp): number {
  if (typeof needle === 'string') {
    return html.split(needle).length - 1;
  }
  return (html.match(needle) ?? []).length;
}

/**
 * Сигналы выбраны устойчивыми к контенту: ItemList JSON-LD рендерится только
 * когда сервер реально получил непустые данные (а не по именам конкретных
 * мест, которые могут выпасть из топа выдачи).
 */
export const SSR_PROBES: SsrProbe[] = [
  {
    name: 'Листинг мест/маршрутов',
    path: '/routes',
    check: (html) => {
      const itemList = countOf(html, 'ItemList');
      return {
        ok: itemList >= 1,
        detail: `ItemList JSON-LD: ${itemList} (ожидание >=1)`,
      };
    },
  },
  {
    name: 'Листинг операторов',
    path: '/operators',
    check: (html) => {
      const cards = countOf(html, /href="\/operators\/[^"]+"/g);
      return {
        ok: cards >= 1,
        detail: `карточек операторов: ${cards} (ожидание >=1)`,
      };
    },
  },
  {
    name: 'Каталог туров',
    path: '/catalog',
    check: (html) => {
      const tours = countOf(html, /href="\/(marketplace|catalog)\/tours\/[^"]+"/g);
      return {
        ok: tours >= 1,
        detail: `ссылок на туры: ${tours} (ожидание >=1)`,
      };
    },
  },
  {
    name: 'Живые цифры главной',
    path: '/',
    check: (html) => {
      const label = countOf(html, 'локаций с координатами');
      return {
        ok: label >= 1,
        detail: `лейбл StatsBand: ${label} (ожидание >=1)`,
      };
    },
  },
];

export interface SsrProbeResult {
  name: string;
  path: string;
  ok: boolean;
  detail: string;
}

export function formatSentinelAlert(failed: SsrProbeResult[], base: string): string {
  const lines = failed.map(
    (f) => `- <b>${f.name}</b> (${base}${f.path}): ${f.detail}`
  );
  return [
    '<b>SSR-сторож: листинги потеряли контент в первом HTML</b>',
    '',
    ...lines,
    '',
    'Google снова видит пустой каркас — регрессия шага 3 (SSR-листинги).',
    'Проверить последние изменения страниц листингов и data-слоя.',
  ].join('\n');
}
