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
  // Anthropic. Хост был в providers.ts с самого начала, но сканер его не видел
  // (см. extractLLMHosts) — то есть зарубежный приёмник ПД проходил мимо D2.
  { host: 'api.anthropic.com', jurisdiction: 'USA', domestic: false, provider: 'Anthropic (Claude, прямой; из РФ гео-блок)' },
  // Alibaba DashScope: текстовый Qwen (providers.ts) + image-модель обложек
  // (cover-image.ts). Как и Anthropic, хост давно жил в providers.ts, но
  // доменный фильтр сканера его не знал — егресс шёл мимо D2. Внесён явно.
  { host: 'dashscope-intl.aliyuncs.com', jurisdiction: 'China', domestic: false, provider: 'Alibaba DashScope (Qwen текст + Qwen-Image обложки)' },
] as const;

const REGISTERED = new Set(LLM_ENDPOINTS.map((e) => e.host));

/**
 * Файлы, из которых уходит трафик в LLM. Сканировать только `providers.ts`
 * недостаточно: `image-tagger.ts` ходит в Anthropic напрямую, минуя waterfall
 * (нужно зрение, а waterfall текстовый), и за ним живой роут
 * `/api/operator/tours/[id]/generate-tags`.
 *
 * Список — часть гварда: новый файл с прямым вызовом провайдера надо внести
 * сюда, иначе его егресс останется вне проверки на 152-ФЗ.
 */
export const LLM_EGRESS_FILES: readonly string[] = [
  'lib/ai/providers.ts',
  'lib/ai/image-tagger.ts',
  // Обложки постов: сочиняет визуальный промпт через текстовый водопад и шлёт
  // его в image-модель DashScope. ПД в промпте нет (только текст новости), но
  // егресс зарубежный — под надзором D2.
  'lib/notifications/cover-image.ts',
] as const;

/**
 * Убрать комментарии: реестр — о том, КУДА РЕАЛЬНО УХОДИТ трафик, а ссылка в
 * пояснении никому ничего не отправляет. Без этого в выборку попадают адреса
 * панелей и документации (console.groq.com — «где взять ключ»), и разработчик
 * вынужден вносить в реестр ПД то, что приёмником ПД не является: реестр
 * перестаёт означать «зарубежный сток ПД» и обесценивается.
 *
 * Закомментированный вызов тоже не шлёт трафика — прятать им хост бессмысленно:
 * чтобы он заработал, код придётся раскомментировать, и гвард тут же увидит.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // `//` считается началом комментария, только если перед ним НЕ двоеточие:
    // иначе вырезается сам `https://...`, и сканер перестаёт видеть вообще всё.
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/** Захардкоженные LLM-хосты, извлечённые из исходника провайдеров. */
export function extractLLMHosts(providersSource: string): string[] {
  const hosts = new Set<string>();
  providersSource = stripComments(providersSource);
  // https://<host> — слеш после хоста НЕ обязателен.
  //
  // Раньше здесь стоял `\/` в конце, и база вида `'https://api.anthropic.com'`
  // (без пути, как её и пишут для релея) не попадала в выборку: сканер молча
  // не видел зарубежный приёмник ПД, а тест при этом был зелёный. Гвард,
  // который пропускает ровно тот случай, ради которого заведён, хуже
  // отсутствующего — на него полагаются.
  const re = /https:\/\/([a-z0-9.-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(providersSource))) {
    // Хвостовые точки/дефисы — из прозы в комментариях, а не часть хоста.
    const host = m[1].toLowerCase().replace(/[.-]+$/, '');
    // LLM-эндпоинты — по известным доменам моделей. Прочее (доки в коментах,
    // github и т.п.) не считаем приёмником ПД.
    if (/deepseek|openrouter|googleapis|groq|cerebras|mistral|openai|anthropic|together\.xyz|yandex|gigachat|sberbank|gigachat\.devices|dashscope|aliyuncs/.test(host)) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

/** Хосты из исходника, которых нет в замороженном реестре. Непусто = нужно ревью. */
export function unregisteredHosts(providersSource: string): string[] {
  return extractLLMHosts(providersSource).filter((h) => !REGISTERED.has(h));
}
