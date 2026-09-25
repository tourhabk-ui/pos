/**
 * Бесплатная квота Qwen кончается ПО МОДЕЛЯМ, а не у ключа (решение владельца
 * 25.09: «работаем на бесплатной»).
 *
 * Проба с раннера того дня (qwen-key-probe, прогон 2): из 27 моделей каталога
 * отвечали 23, а 403 `AllocationQuota.FreeTierOnly` давали ровно две — те, что
 * звал наш код: `qwen-plus` (цикл инструментов Кузьмича) и `qwen3.8-max`
 * (сильнейшая по каталогу, первая фаза разведчика). Соседи с отдельной квотой —
 * `qwen-plus-latest`, `qwen3.8-max-0902` — отвечали за доли секунды. Код же
 * стучался в исчерпанную модель на каждом сообщении человека и молча уходил
 * на следующую ступень, а health будил «Qwen не отвечает».
 *
 * Здесь — память процесса о моделях, у которых квота кончилась, и правило,
 * кто их замещает. Без сети и без БД: провайдеры зовут это сами.
 *
 * Отметка живёт сутки, а не вечно: владелец может снять режим «только
 * бесплатная квота», и тогда модель снова должна пробоваться первой. Цена
 * суточной перепроверки — один лишний отказ в 300 мс.
 */

export const FREE_QUOTA_MARK_TTL_MS = 24 * 60 * 60 * 1000;

const marks = new Map<string, number>();

/**
 * Ответ шлюза значит «бесплатная квота ЭТОЙ модели кончилась, а платить
 * запрещено режимом free tier». Узко намеренно: 403 без этой формы — другой
 * отказ (регион, права), и прятать его под «квоту» нельзя.
 */
export function isFreeQuotaExhausted(status: number | null, body: string): boolean {
  return status === 403 && /FreeTierOnly|free quota has been exhausted/i.test(body);
}

export function markFreeQuotaExhausted(model: string, now = Date.now()): void {
  marks.set(model, now + FREE_QUOTA_MARK_TTL_MS);
}

export function isMarkedExhausted(model: string, now = Date.now()): boolean {
  const until = marks.get(model);
  if (until === undefined) return false;
  if (until <= now) { marks.delete(model); return false; }
  return true;
}

/** Модели с живой отметкой — для ответа health, чтобы подмена была видна. */
export function exhaustedModels(now = Date.now()): string[] {
  return [...marks.keys()].filter((m) => isMarkedExhausted(m, now)).sort();
}

/** Только для тестов. */
export function resetFreeQuotaMarks(): void {
  marks.clear();
}

/**
 * Кто замещает модель с исчерпанной квотой на живом пути: та же модель под
 * другим id — алиас `-latest` и датированные снимки (`qwen-plus-2025-07-28`,
 * `qwen3.8-max-0902`). Не «любая модель каталога»: цикл инструментов держит
 * средний тир ради задержки (человек ждёт ответа в поле), и подмена на
 * сильнейшую там — пять секунд вместо половины.
 *
 * Порядок: алиас `-latest` первым (он и есть «текущая версия»), затем снимки
 * от свежих к старым.
 */
export function freeQuotaSiblings(model: string, catalog: readonly string[]): string[] {
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sibling = new RegExp(`^${esc}-(latest|\\d{4}(-\\d{2}-\\d{2})?)$`);
  const found = [...new Set(catalog.filter((id) => sibling.test(id)))];
  return found.sort((a, b) => {
    const al = a.endsWith('-latest') ? 1 : 0;
    const bl = b.endsWith('-latest') ? 1 : 0;
    return bl - al || b.localeCompare(a);
  });
}

/**
 * Первая модель без отметки из [основная, ...замены]. `null` — квота кончилась
 * у всех, и ступень честно отказывает (следующая в водопаде ответит).
 */
export function firstUnexhausted(models: readonly string[], now = Date.now()): string | null {
  return models.find((m) => !isMarkedExhausted(m, now)) ?? null;
}
