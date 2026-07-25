/**
 * Правила валидации постов перед публикацией в каналы (TG, MAX).
 *
 * Каждый пост ОБЯЗАН пройти валидацию перед отправкой.
 * Если валидация не пройдена — пост не публикуется, ошибка логируется.
 */

import { query } from '@/lib/database';
import { getPublicBaseUrl } from '@/lib/config';
import { hasSourceAttribution } from '@/lib/text/source-attribution';
import { isWaterfallErrorResponse } from '@/lib/ai/providers';

// ── Типы ──────────────────────────────────────────────────────────────────────

export interface PostValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  routeId?: string;
  routeTitle?: string;
}

interface RouteCheck {
  id: string;
  title: string;
  description: string | null;
  is_visible: boolean;
  location_type: string | null;
  activity_type: string | null;
  photos: unknown;
  lat: number | null;
  lng: number | null;
}

// ── Правила ───────────────────────────────────────────────────────────────────

/**
 * Правило 1: Маршрут существует в БД и is_visible = TRUE.
 * Без этого ссылка ведёт на 404.
 */
async function checkRouteExists(routeId: string): Promise<{ exists: boolean; route?: RouteCheck }> {
  try {
    const res = await query<RouteCheck>(
      `SELECT id, title, description, is_visible,
              location_type, activity_type,
              payload->'photos' AS photos,
              lat, lng
       FROM agent_route_knowledge
       WHERE id = $1`,
      [routeId]
    );
    if (!res.rows[0]) return { exists: false };
    return { exists: true, route: res.rows[0] };
  } catch {
    return { exists: false };
  }
}

/**
 * Правило 2: Страница маршрута отдаёт HTTP 200 на проде.
 * Защита от расхождений между БД и билдом.
 */
async function checkPageAccessible(routeId: string): Promise<boolean> {
  const appUrl = getPublicBaseUrl();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${appUrl}/routes/${routeId}`, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    return res.status === 200;
  } catch {
    // Если не можем проверить (нет сети, таймаут) — пропускаем проверку, но пишем warning
    return true; // не блокируем, но warning добавим отдельно
  }
}

/**
 * Правило 3: Пост содержит ссылки только на существующие страницы.
 * Проверяет все ссылки вида vedarai.ru/... в тексте поста.
 */
function extractInternalLinks(text: string): string[] {
  const appUrl = (getPublicBaseUrl()).replace(/\/$/, '');
  const regex = new RegExp(`${appUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[\\w\\d/\\-]+)`, 'g');
  const links: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    links.push(match[1]);
  }
  return links;
}

const MIN_POST_CHARS = 30;
const MAX_POST_CHARS = 2000;

/**
 * Правило 4: причины НЕ публиковать, видимые по одному тексту — без сети и БД.
 *
 * Вынесено отдельно и синхронным, чтобы этим же правилом мог закрыться сам
 * канал публикации (postToAllChannels), а не только те публикаторы, которые
 * не забыли позвать валидацию.
 *
 * Отдельная проверка на заглушку отказа AI — не роскошь. 25.07.2026 в канал
 * ушёл пост «Сервис временно недоступен.»: waterfall при отказе ВСЕХ
 * провайдеров возвращает строку, а не бросает исключение, и публикатор принял
 * её за текст. Ловить это длиной нельзя: у callAIFast заглушка 27 символов и
 * случайно не проходит порог в 30, а у callAIWaterfall — «Извините, сервис
 * временно недоступен. Попробуйте позже.», 54 символа, и порог она проходит.
 * Поэтому сверяемся с реестром заглушек (isWaterfallErrorResponse), а не с
 * длиной: один источник правды с providers.ts.
 */
export function blockingTextIssue(text: string): string | null {
  const stripped = text.replace(/<[^>]+>/g, '').trim();
  if (!stripped) return 'текст поста пустой';
  if (isWaterfallErrorResponse(stripped)) {
    return 'это заглушка отказа AI, а не пост';
  }
  if (stripped.length < MIN_POST_CHARS) {
    return `текст слишком короткий (${stripped.length} символов, мин. ${MIN_POST_CHARS})`;
  }
  if (stripped.length > MAX_POST_CHARS) {
    return `текст слишком длинный (${stripped.length} символов, макс. ${MAX_POST_CHARS})`;
  }
  return null;
}

function checkTextQuality(text: string): string[] {
  const issue = blockingTextIssue(text);
  return issue ? [issue] : [];
}

/**
 * Правило 5: AI не вставил запрещённый контент.
 */
function checkProhibitedContent(text: string): string[] {
  const errors: string[] = [];
  // AI иногда вставляет placeholder-ы
  if (/\[вставь|TODO|FIXME|placeholder/i.test(text)) {
    errors.push('Текст содержит placeholder/TODO');
  }
  // Ссылки на несуществующие домены
  if (/example\.com|placeholder\.com|unsplash\.com/i.test(text)) {
    errors.push('Текст содержит тестовые URL');
  }
  // Утечка атрибуции стороннего источника (кейс «Бухта Асача»: в пост/описание
  // просочилось «ИдиЛесом» из скрейпа). Реклама конкурента в нашем канале —
  // блокируем детерминированно, а не абзацем в промпте Кузьмича (CLAUDE.md §8).
  if (hasSourceAttribution(text)) {
    errors.push('Текст содержит упоминание стороннего источника (ИдиЛесом)');
  }
  return errors;
}

/**
 * Правило 6: Все ссылки в тексте поста реально доступны (HTTP HEAD).
 * Проверяет https:// ссылки. Таймаут 5с. Недоступные → error.
 */
async function verifyAllLinks(text: string): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Извлекаем все URL (из href="..." и из голого текста)
  const urlRegex = /https?:\/\/[^\s"'<>)\]]+/gi;
  const urls = [...new Set(text.match(urlRegex) || [])];

  if (urls.length === 0) return { errors, warnings };

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'TourHab-LinkChecker/1.0' },
        });
        clearTimeout(timeout);

        // HEAD может возвращать 405 (Method Not Allowed) — пробуем GET
        if (res.status === 405) {
          const controller2 = new AbortController();
          const timeout2 = setTimeout(() => controller2.abort(), 5000);
          const res2 = await fetch(url, {
            method: 'GET',
            signal: controller2.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'TourHab-LinkChecker/1.0' },
          });
          clearTimeout(timeout2);
          // Потребляем body чтобы не висеть
          await res2.text().catch(() => {});
          return { url, status: res2.status };
        }

        return { url, status: res.status };
      } catch {
        return { url, status: 0 };
      }
    })
  );

  for (const r of results) {
    if (r.status === 'rejected') continue;
    const { url, status } = r.value;
    if (status === 0) {
      // Сетевая ошибка / таймаут — warning, не блокируем
      warnings.push(`Ссылка ${url} — не удалось проверить (таймаут/сеть)`);
    } else if (status >= 400) {
      errors.push(`Ссылка ${url} недоступна (HTTP ${status})`);
    }
  }

  return { errors, warnings };
}

// ── Главная валидация ─────────────────────────────────────────────────────────

/**
 * Полная валидация поста маршрута перед публикацией.
 * Вызывать ПЕРЕД tgPost/tgPostPhoto.
 */
export async function validateRoutePost(routeId: string, text: string): Promise<PostValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Маршрут существует и виден
  const { exists, route } = await checkRouteExists(routeId);
  if (!exists) {
    errors.push(`Маршрут ${routeId} не найден в БД`);
    return { valid: false, errors, warnings, routeId };
  }
  if (!route!.is_visible) {
    errors.push(`Маршрут "${route!.title}" скрыт (is_visible = FALSE)`);
    return { valid: false, errors, warnings, routeId, routeTitle: route!.title };
  }

  // 2. Страница доступна на проде (HEAD-запрос)
  const pageOk = await checkPageAccessible(routeId);
  if (!pageOk) {
    errors.push(`Страница /routes/${routeId} отдаёт не-200 на проде`);
  }

  // 3. Текст поста
  errors.push(...checkTextQuality(text));
  errors.push(...checkProhibitedContent(text));

  // 4. Все ссылки в тексте реально доступны
  const linkCheck = await verifyAllLinks(text);
  errors.push(...linkCheck.errors);
  warnings.push(...linkCheck.warnings);

  // 5. Маршрут имеет описание
  if (!route!.description || route!.description.trim().length < 20) {
    warnings.push('У маршрута нет полноценного описания');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    routeId,
    routeTitle: route!.title,
  };
}

/**
 * Валидация текстового поста (tip, sezon, promo) — без привязки к маршруту.
 */
export async function validateTextPost(text: string): Promise<PostValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  errors.push(...checkTextQuality(text));
  errors.push(...checkProhibitedContent(text));

  // Проверяем все ссылки реально доступны
  const linkCheck = await verifyAllLinks(text);
  errors.push(...linkCheck.errors);
  warnings.push(...linkCheck.warnings);

  // Проверяем что внутренние ссылки ведут на реальные разделы
  const links = extractInternalLinks(text);
  const knownPrefixes = ['/routes', '/marketplace', '/map', '/safety', '/planner', '/contact', '/faq', '/for-operators'];
  for (const link of links) {
    const isKnown = knownPrefixes.some(p => link.startsWith(p));
    if (!isKnown) {
      warnings.push(`Ссылка ${link} может быть недоступна`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Логирование результата валидации (если не прошла).
 */
export async function logValidationFailure(
  postType: string,
  result: PostValidationResult
): Promise<void> {
  if (result.valid) return;
  try {
    await query(
      `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
      [
        'post_validation_failed',
        JSON.stringify({
          post_type: postType,
          route_id: result.routeId,
          route_title: result.routeTitle,
          errors: result.errors,
          warnings: result.warnings,
          timestamp: new Date().toISOString(),
        }),
      ]
    );
  } catch { /* таблица может не существовать */ }
}
