/**
 * Структурные объективы эволюции — кросс-файловые факты, которые не видны
 * ни в скользящем git-окне aiCodeReview, ни в per-file static-checks.
 *
 * Родились из ручного аудита 27.07: в кабинете трансфер-оператора страницы
 * «Брони» и «Маршруты» месяцами жили ВНЕ сайдбара (сироты — добраться можно
 * было только прямой ссылкой), а API водителей/автопарка умели POST, на
 * который ни один клиент не слал запрос (оператор не мог ничего добавить).
 * Обе дыры — старый код без свежих диффов: движок их не видел by construction.
 *
 * Философия та же, что у static-checks: детерминированный поиск факта, не
 * оценка модели. Либо нашли — либо молчим.
 *
 * Чистые функции: (списки путей, тела файлов) → находки. Ни сети, ни БД —
 * данные им готовит вызывающий (growth-agent), который знает бюджет чтения.
 */
import type { GrowthIssue } from '@/lib/agents/evo/growth-agent';

/**
 * Сегменты хабов, которым НЕ место в сайдбаре по замыслу:
 * onboarding — визард первого входа, в него уводит гейт, а не навигация.
 * Новое осознанное исключение — сюда, с причиной.
 */
export const ORPHAN_EXCLUDED_SEGMENTS = new Set(['onboarding']);

const HUB_PAGE_RE = /^app\/hub\/([^/]+)\/([^/[]+)\/page\.tsx$/;

/** app/hub/<role>/layout.tsx для всех ролей из списка файлов. */
export function hubLayoutPaths(files: string[]): string[] {
  return files.filter((p) => /^app\/hub\/[^/]+\/layout\.tsx$/.test(p));
}

/**
 * Страница хаба верхнего уровня, которой нет в сайдбаре собственного layout.
 *
 * Проверяется ФАКТ «href отсутствует в тексте layout.tsx» — ровно то, что
 * ломало трансфер-оператора. Глубокие страницы (details, [id]) и сегменты из
 * ORPHAN_EXCLUDED_SEGMENTS не проверяются: им в сайдбаре не место by design.
 */
export function findOrphanHubPages(
  files: string[],
  layoutBodies: Map<string, string>,
  pageBodies?: Map<string, string>,
): GrowthIssue[] {
  const issues: GrowthIssue[] = [];

  for (const p of files) {
    const m = HUB_PAGE_RE.exec(p);
    if (!m) continue;
    const [, role, segment] = m;
    if (ORPHAN_EXCLUDED_SEGMENTS.has(segment)) continue;

    const layoutPath = `app/hub/${role}/layout.tsx`;
    const layout = layoutBodies.get(layoutPath);
    // Нет layout или не прочитали — молчим: без текста сайдбара факта нет.
    if (!layout) continue;

    const href = `/hub/${role}/${segment}`;
    if (layout.includes(href)) continue;

    // Страница-редирект — не сирота, а сохранённый старый URL (прецеденты:
    // eco-points → loyalty, operator/register → /auth/register-operator).
    // Тело страницы передаёт вызывающий (читаются только кандидаты — их
    // единицы); без тела считаем страницей — лучше находка, чем молчание.
    const body = pageBodies?.get(p);
    if (body && /\bredirect\(/.test(body)) continue;

    issues.push({
      category: 'ux',
      severity: 'medium',
      file_path: p,
      title: `Страница вне сайдбара хаба: ${href}`,
      description:
        `${p} существует, но в ${layoutPath} нет ссылки «${href}» — из кабинета до страницы ` +
        `не добраться, только прямым URL. Проверено детерминированно: поиск строки href в тексте layout. ` +
        `Прецедент: «Брони» и «Маршруты» трансфер-оператора жили сиротами до аудита 27.07.`,
      suggestion:
        `Добавить пункт в SIDEBAR_ITEMS (${layoutPath}) с icon и section — или, если страница ` +
        `не для навигации by design, внести сегмент в ORPHAN_EXCLUDED_SEGMENTS ` +
        `(lib/agents/evo/structural-scan.ts) с причиной.`,
    });
  }

  return issues;
}

/** API-префиксы партнёрских кабинетов: у их POST обязана быть форма в UI. */
const HUB_API_PREFIXES = [
  'app/api/transfer-operator/',
  'app/api/transfer/',
  'app/api/gear/',
  'app/api/stay/',
  'app/api/guide/',
  'app/api/agent/',
];

const POST_EXPORT_RE = /export\s+(?:async\s+function\s+POST\s*\(|\{[^}]*\bPOST\b[^}]*\})/;

/** `app/api/x/y/route.ts` → `/api/x/y`. */
function apiUrlOf(path: string): string {
  return '/' + path.replace(/^app\//, '').replace(/\/route\.ts$/, '');
}

/**
 * API кабинета умеет POST, но ни один клиент этот POST не шлёт.
 *
 * Ровно кейс трансфер-оператора: createDriverSchema/createVehicleSchema ждали
 * запросов, а в UI не было ни одной формы — «Добавить» вело в тупик. Проверка
 * текстовая и консервативная: находка только если URL роута ВСТРЕЧАЕТСЯ в
 * клиентах (поверхность подключена — читает), но ни в одном упоминающем файле
 * нет POST-запроса. Роут, который UI не знает вовсе, — не наш случай (может
 * быть межсервисным/внешним), молчим.
 */
export function findPostWithoutClientUsage(
  routeBodies: Map<string, string>,
  clientBodies: Map<string, string>,
): GrowthIssue[] {
  const issues: GrowthIssue[] = [];

  for (const [routePath, routeBody] of routeBodies) {
    if (!HUB_API_PREFIXES.some((pre) => routePath.startsWith(pre))) continue;
    if (routePath.includes('[')) continue; // динамические пути: URL в клиенте собран шаблоном
    if (!POST_EXPORT_RE.test(routeBody)) continue;

    const url = apiUrlOf(routePath);
    let mentioned = false;
    let postsSomewhere = false;
    for (const body of clientBodies.values()) {
      if (!body.includes(url)) continue;
      mentioned = true;
      if (/method:\s*['"]POST['"]/.test(body)) {
        postsSomewhere = true;
        break;
      }
    }
    if (!mentioned || postsSomewhere) continue;

    issues.push({
      category: 'ux',
      severity: 'medium',
      file_path: routePath,
      title: `POST без формы в UI: ${url}`,
      description:
        `${routePath} экспортирует POST, клиенты читают ${url}, но ни в одном упоминающем файле ` +
        `нет запроса с method: 'POST' — создание через кабинет невозможно. Проверено детерминированно ` +
        `по текстам клиент-компонентов. Прецедент: водители/автопарк трансфер-оператора до 27.07.`,
      suggestion:
        `Добавить форму создания в клиент кабинета (по образцу _VehiclesPageClient/_DriversPageClient: ` +
        `поля из Zod-схемы роута, ошибки сервера видимы, refetch после сохранения) — либо удалить ` +
        `мёртвый POST из роута, если создание не нужно.`,
    });
  }

  return issues;
}
