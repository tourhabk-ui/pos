/**
 * Замороженный реестр LLM-эндпоинтов, куда уходит трафик из `lib/ai/providers.ts`.
 *
 * Зачем: 152-ФЗ различает передачу ПД внутри РФ и трансграничную. Все сильные
 * модели, достижимые из РФ напрямую, — ЗАРУБЕЖНЫЕ (Китай/США/ЕС). Появление
 * нового провайдера должно быть СОЗНАТЕЛЬНЫМ: guard-тест сверяет хосты в
 * `providers.ts` с этим реестром и падает на незнакомом хосте. Разработчик обязан
 * прописать сюда юрисдикцию — тем самым признав «да, ещё один зарубежный приёмник
 * ПД, и я знаю про 152-ФЗ». Это не мешает добавлять провайдеры — заставляет думать.
 *
 * `domestic: true` — хост в РФ (ПД можно слать без чистки: YandexGPT/GigaChat).
 * Пока таких нет: весь ИИ-трафик зарубежный, поэтому промпты чистит `redactPII`.
 */

export interface LLMEndpoint {
  /** Хост как встречается в URL (без схемы/пути). */
  host: string;
  /** Юрисдикция приёмника: страна/регион. */
  jurisdiction: string;
  /** true = сервер в РФ (трансграничной передачи нет). */
  domestic: boolean;
  /** Провайдер/назначение — для читаемости реестра. */
  provider: string;
}

export const LLM_ENDPOINTS: readonly LLMEndpoint[] = [
  // Единственный ДОМАШНИЙ сток: сервер в РФ, трансграничной передачи нет.
  { host: 'llm.api.cloud.yandex.net', jurisdiction: 'Russia', domestic: true, provider: 'YandexGPT' },
  { host: 'api.deepseek.com', jurisdiction: 'China', domestic: false, provider: 'DeepSeek' },
  { host: 'openrouter.ai', jurisdiction: 'USA', domestic: false, provider: 'OpenRouter (реле флагманов)' },
  { host: 'generativelanguage.googleapis.com', jurisdiction: 'USA', domestic: false, provider: 'Google Gemini' },
  { host: 'api.groq.com', jurisdiction: 'USA', domestic: false, provider: 'Groq' },
  { host: 'api.cerebras.ai', jurisdiction: 'USA', domestic: false, provider: 'Cerebras' },
  { host: 'api.mistral.ai', jurisdiction: 'EU (France)', domestic: false, provider: 'Mistral' },
] as const;

const REGISTERED = new Set(LLM_ENDPOINTS.map((e) => e.host));

/** Захардкоженные LLM-хосты, извлечённые из исходника провайдеров. */
export function extractLLMHosts(providersSource: string): string[] {
  const hosts = new Set<string>();
  // https://<host>/... — только реальные литералы в коде (env-релеи динамические, их пропускаем).
  const re = /https:\/\/([a-z0-9.-]+)\//gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(providersSource))) {
    const host = m[1].toLowerCase();
    // LLM-эндпоинты — по известным доменам моделей. Прочее (доки в коментах,
    // github и т.п.) не считаем приёмником ПД.
    if (/deepseek|openrouter|googleapis|groq|cerebras|mistral|openai|anthropic|together\.xyz|yandex|gigachat|sberbank|gigachat\.devices/.test(host)) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

/** Хосты из исходника, которых нет в замороженном реестре. Непусто = нужно ревью. */
export function unregisteredHosts(providersSource: string): string[] {
  return extractLLMHosts(providersSource).filter((h) => !REGISTERED.has(h));
}
