/**
 * Сторонние приложения в дорогу — таблица external_tools.
 *
 * Это НЕ инструменты Ведара. Их делают другие компании; Кузьмич советует их
 * для узких задач (инструмент search_taaft), страница /ai-tools показывает
 * списком. Владелец 07.11 считал этот каталог нашими инструментами — и
 * «карт-бланш» на чистку: из 48 посеянных 666 записей остались пять
 * (миграция 1396), без безопасности и без того, что Ведар делает сам.
 *
 * Правила:
 *   - безопасность (SOS, обстановка, вулканы, погода) сторонним приложением
 *     не закрывается — ответ называет инструменты Ведара и 112;
 *   - определитель по фото подсказывает вид, а не съедобность — это сказано
 *     рядом с каждым таким приложением;
 *   - подбор под задачу не придумывает: ничего не подошло — так и сказано,
 *     и дан весь список (он короткий), а не «похожее» наугад.
 *
 * Имя файла и инструмента осталось от каталога TAAFT (theresanaiforthat.com),
 * из которого в таблицу не пришло ни одной записи. Правила списка без базы —
 * lib/travel-apps/catalog.ts.
 */
import { pool } from '@/lib/db-pool';
import { matchApps, type ExternalTool } from '@/lib/travel-apps/catalog';

export { APP_CATEGORIES, NATURE_CAUTION, SAFETY_POINTER, formatAppsForKuzmich, matchApps, queryRoots, type ExternalTool } from '@/lib/travel-apps/catalog';

/** Все показываемые приложения, по разделу и имени. Отказ базы — исключение: «не загрузилось» решает вызывающий. */
export async function listTravelApps(): Promise<ExternalTool[]> {
  const { rows } = await pool.query<ExternalTool>(
    `SELECT id::text AS id, slug, name, description, url, category, tags, is_free
       FROM external_tools
      WHERE verified = TRUE
      ORDER BY category, name`,
  );
  return rows;
}

/** Для Evo: только подошедшие под задачу, без «всего списка». */
export async function searchExternalTools(task: string, limit = 5): Promise<ExternalTool[]> {
  if (!task.trim()) return [];
  return matchApps(task, await listTravelApps()).slice(0, limit);
}

export async function trackToolUsage(slug: string): Promise<void> {
  await pool.query(
    `UPDATE external_tools
     SET use_count = use_count + 1, last_used_at = NOW()
     WHERE slug = $1`,
    [slug],
  );
}

