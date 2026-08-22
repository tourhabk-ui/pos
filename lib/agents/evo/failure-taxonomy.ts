/**
 * Где именно сломалось: ребро взаимодействия и виновная сторона.
 *
 * Схема из «Model or Harness?» (Scale AI, arXiv:2607.28802). Единица анализа —
 * не компонент, а РЕБРО между двумя компонентами плюс `fault_side`: какая из
 * двух сторон подлежит починке. Их пример: агент сообщает об успешном вызове
 * инструмента, который на деле упал. Обёртка проглотила ошибку — чинить
 * обёртку. Обёртка ошибку вернула, а модель её проигнорировала — чинить модель.
 * Ребро одно, ремонт разный.
 *
 * Зачем это нам. Точность эволюции (lib/agents/evo/precision.ts) до сих пор
 * считалась одним числом на все находки и понималась как «врёт ли модель». Но
 * половина находок — про инфраструктуру: сборку, деплой, сеть, наши же сторожа.
 * Отвергнутая инфраструктурная находка тянула вниз общий порог, из-под которого
 * гаснут код-находки. Метрика наказывала модель за то, к чему модель отношения
 * не имеет.
 *
 * Разбор наших собственных сбоев за 04–05.08 показал, что дороже всего обошёлся
 * ГРЕЙДЕР — измеритель, отвечавший не на тот вопрос: проверка деплоя печатала
 * «Status: deploy» как успех (трое суток), потом краснела, не дав сборке начаться,
 * а сторожа спотыкались о собственные комментарии. Ни одно из этого не «модель
 * ошиблась».
 *
 * Классификация здесь ДЕТЕРМИНИРОВАННАЯ — по категории находки и словам её
 * текста. Модель к разметке не допускается: она уже врала (10 ложных critical
 * 24.07), и доверять ей вывод о собственной вине — то же самое, что спрашивать
 * подсудимого о приговоре. Судья-LLM в статье даёт κ = 0.76, но там он один из
 * нескольких независимых аналитиков, а не единственный источник.
 */

/** Компоненты агентной системы (Table 1 статьи), сведённые к нашей реальности. */
export const COMPONENTS = [
  'model',      // сама LLM — решатель, Кузьмич, генератор находок
  'harness',    // наша обвязка: клиенты провайдеров, парсеры ответов, контекст
  'tool',       // инструменты и интеграции: вебхуки, фиды, API площадок
  'memory',     // данные, переживающие сессию: БД, миграции, кэши
  'grader',     // измеритель: сторожа, проверка деплоя, метрики, CI
  'environment', // окружение: сборка, сеть, прод-инфраструктура, внешние сервисы
  'owner',      // человек, ставящий задачу и принимающий результат
] as const;

export type Component = typeof COMPONENTS[number];

/** Сторона, которую надо чинить. */
export const FAULT_SIDES = COMPONENTS;
export type FaultSide = Component;

export interface FailureLocation {
  /** Ребро в канонической форме «a—b» (стороны отсортированы). */
  edge: string;
  /** Кого чинить. */
  faultSide: FaultSide;
}

/** Канонический вид ребра: порядок сторон не должен влиять на группировку. */
export function makeEdge(a: Component, b: Component): string {
  return [a, b].sort().join('—');
}

export function isComponent(value: string): value is Component {
  return (COMPONENTS as readonly string[]).includes(value);
}

/** Обе стороны ребра. Неразбираемое ребро — пустой массив, а не догадка. */
export function edgeSides(edge: string): Component[] {
  const parts = edge.split('—');
  if (parts.length !== 2) return [];
  return parts.every(isComponent) ? (parts as Component[]) : [];
}

/** Метка допустима, только если сторона реально участвует в ребре. */
export function isConsistent(loc: FailureLocation): boolean {
  const sides = edgeSides(loc.edge);
  return sides.length === 2 && sides.includes(loc.faultSide);
}

/**
 * Категории находок Growth Scan → место отказа по умолчанию.
 *
 * `bug` и `intel` сочиняет модель — там она и виновата, пока текст не скажет
 * иное. Детерминированные категории (static-checks, мок-детектор) читают
 * синтаксис: если такая находка ошибочна, ошибся наш инструмент, а не модель.
 */
const CATEGORY_DEFAULT: Record<string, FailureLocation> = {
  bug:       { edge: makeEdge('model', 'harness'), faultSide: 'model' },
  intel:     { edge: makeEdge('model', 'owner'),   faultSide: 'model' },
  security:  { edge: makeEdge('harness', 'tool'),  faultSide: 'harness' },
  ux:        { edge: makeEdge('harness', 'owner'), faultSide: 'harness' },
  tech_debt: { edge: makeEdge('harness', 'memory'), faultSide: 'harness' },
};

/**
 * Слова, по которым место отказа определяется однозначнее категории.
 * Порядок важен: первое совпадение выигрывает, поэтому специфичное — выше.
 */
const TEXT_RULES: Array<{ test: RegExp; loc: FailureLocation }> = [
  // Грейдер: измеритель соврал. Самый дорогой класс в нашей практике.
  {
    test: /сторож|guard-тест|тест[а-яё]* (?:врёт|ложн)|ложно-зелён|ложное падение|проверка деплоя|CI (?:зелён|врёт)|метрик[а-яё]* (?:врёт|наказывает)/i,
    loc: { edge: makeEdge('grader', 'harness'), faultSide: 'grader' },
  },
  // Окружение: сборка, рантайм, сеть, внешний сервис.
  {
    test: /сборк[а-яё]|deploy|деплой|docker|node \d|версия рантайма|таймаут сети|EDGE|недоступен|502|503|gateway/i,
    loc: { edge: makeEdge('environment', 'harness'), faultSide: 'environment' },
  },
  // Инструмент/интеграция: наш клиент к чужому API, вебхук, фид.
  {
    test: /вебхук|webhook|фид|feed|API[- ]ключ|разбор ответа|парсер ответа|401|интеграц/i,
    loc: { edge: makeEdge('harness', 'tool'), faultSide: 'tool' },
  },
  // Данные, пережившие сессию: миграции, расхождение полей, дубли.
  {
    test: /миграц|схема (?:БД|базы)|дубл[иь]|расход[а-яё]* (?:данн|полей)|кэш устарел/i,
    loc: { edge: makeEdge('harness', 'memory'), faultSide: 'memory' },
  },
  // Модель: галлюцинация, выдуманный факт, несуществующий код.
  {
    test: /галлюцин|выдум|несуществующ|модель (?:соврала|ошиблась)|придума/i,
    loc: { edge: makeEdge('model', 'harness'), faultSide: 'model' },
  },
];

/**
 * Где сломалось. `null` — определить нечем: догадка здесь хуже пропуска, потому
 * что на этой метке висит решение о публикации.
 */
export function locateFailure(input: { category: string; title?: string | null; description?: string | null; suggestion?: string | null }): FailureLocation | null {
  const text = [input.title, input.description, input.suggestion].filter(Boolean).join(' ');
  for (const rule of TEXT_RULES) {
    if (rule.test.test(text)) return rule.loc;
  }
  return CATEGORY_DEFAULT[input.category] ?? null;
}

