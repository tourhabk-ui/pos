/**
 * Выбор модели БЕЗ привязки к конкретному id. Провайдер меняет линейку —
 * `pickBestModel` сам выбирает сильнейшую ОБЩУЮ модель из того, что реально
 * отдаёт /v1/models. Ничего не хардкодим: ни `deepseek-chat`, ни `qwen-max`.
 *
 * Чистая функция — под тестом. Правила выбора:
 *  1. Отсекаем неподходящие классы: reasoner/thinking (ломают JSON-вывод ревью
 *     тегами <think>), мультимодальные (vl/vision/audio/omni), служебные
 *     (embed/rerank/ocr/math/tts/image/moderation/guard/asr).
 *  2. Ранжируем: тир (max>pro>plus/chat>turbo/flash) × версия × бонус за
 *     «скользящий» алиас (…-latest / *chat) — алиас безопаснее закреплённого
 *     снапшота, провайдер сам держит его новейшим.
 *  3. Годы (2024/2025…) в версиях игнорируем, чтобы датированный снапшот не
 *     перебил алиас.
 */

// Классы, непригодные для решателя (код-ревью + JSON-извлечение).
const EXCLUDE = /(reasoner|thinking|[-_]r1(\b|$)|vl(\b|[-_])|vision|audio|omni|voice|embed|rerank|ocr|\bmath\b|tts|image|whisper|moderation|guard|realtime|asr|coder)/i;

function tierWeight(id: string): number {
  const s = id.toLowerCase();
  if (/(^|[-_])max(\b|[-_]|$)/.test(s)) return 5;
  if (/(^|[-_])pro(\b|[-_]|$)/.test(s)) return 4;
  if (/(^|[-_])plus(\b|[-_]|$)/.test(s)) return 3;
  if (/chat/.test(s)) return 3;                 // deepseek-chat — флагман general
  if (/(turbo|flash)/.test(s)) return 2;
  return 1;
}

/** Максимальная «версия» из id, игнорируя годы (числа ≥ 100). */
function versionScore(id: string): number {
  const nums = (id.match(/\d+(?:\.\d+)?/g) ?? [])
    .map(Number)
    .filter((n) => n > 0 && n < 100);
  return nums.length ? Math.max(...nums) : 0;
}

/** Скользящий алиас предпочтительнее закреплённого снапшота. */
function aliasBonus(id: string): number {
  return /(^|[-_])latest(\b|[-_]|$)|chat$/i.test(id) ? 1 : 0;
}

export function scoreModel(id: string): number {
  return tierWeight(id) * 1000 + versionScore(id) * 10 + aliasBonus(id) * 300;
}

/**
 * Лучшая общая модель из списка id, либо null если подходящих нет.
 * Детерминированно: при равенстве баллов — лексикографически меньший id.
 */
export function pickBestModel(ids: readonly string[]): string | null {
  const cand = ids.filter((id) => typeof id === 'string' && id.length > 0 && !EXCLUDE.test(id));
  if (cand.length === 0) return null;
  return cand
    .map((id) => ({ id, score: scoreModel(id) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0].id;
}
