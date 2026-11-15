/**
 * lib/kuzmich/turn-steps.ts — настоящие шаги хода Кузьмича для веб-чата
 * (#3412, п. 4; слово владельца 15.11 «карт-бланш»).
 *
 * Шаг — это вызов инструмента, который цикл уже записал в журнал хода
 * (ToolRun), названный словами. «Мысли модели» не показываются: текст модели
 * человек видит только после проверок (finishKuzmichAnswer). В шаге нет
 * аргументов инструмента — ни места, ни дат, ни телефона: только что делается.
 *
 * Сервер шлёт шаги, только если клиент попросил поток (Accept:
 * text/event-stream); итог хода — тот же JSON, что и без потока, последним
 * событием. Клиентский разбор — readChatAnswer ниже, один на /kuzmich и виджет.
 */

const STEP_WORDS: Record<string, string> = {
  get_guardian_context: 'Проверяю обстановку и безопасность места',
  safety_status: 'Смотрю обстановку в крае',
  get_volcano_status: 'Смотрю состояние вулканов',
  get_weather: 'Смотрю погоду',
  get_place_info: 'Читаю карточку места',
  get_tours: 'Ищу туры',
  get_tour_details: 'Читаю описание тура',
  get_tour_availability: 'Проверяю свободные места',
  compare_tours: 'Сравниваю туры',
  search_accommodations: 'Ищу жильё',
  search_transfers: 'Ищу трансферы',
  search_car_rental: 'Ищу прокат машин',
  search_gear: 'Ищу снаряжение',
  search_kamchatka: 'Ищу в данных Ведара',
  search_taaft: 'Ищу в данных Ведара',
  make_trip_plan: 'Собираю план поездки',
  edit_trip_plan: 'Правлю план поездки',
  get_flight_board: 'Смотрю табло аэропорта',
};

/** Шаг словами. Незнакомый инструмент — общими словами, а не его именем. */
export function stepLabel(toolName: string): string {
  return STEP_WORDS[toolName] ?? 'Проверяю данные Ведара';
}

/** Инструменты, у которых есть слова: сторож держит их полными. */
export const STEP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(STEP_WORDS));

/**
 * Журнал хода, который сообщает о каждой записи. Цикл пишет в него как в
 * обычный массив; повтор того же шага подряд не дублируется.
 */
// Тип записи — по форме, без импорта журнала (lib/agents/eval/grounding):
// модуль едет в браузер, а там серверная регулярка с lookbehind.
export function observedToolRuns<T extends { name: string }>(onStep: (label: string) => void): T[] {
  const runs: T[] = [];
  const push = runs.push.bind(runs);
  let last = '';
  runs.push = (...items: T[]) => {
    const n = push(...items);
    for (const item of items) {
      const label = stepLabel(item.name);
      if (label !== last) { last = label; onStep(label); }
    }
    return n;
  };
  return runs;
}

export type ChatStreamEvent =
  | { type: 'step'; label: string }
  | { type: 'final'; status: number; body: unknown };

/** Строка SSE одного события. */
export function sseEvent(e: ChatStreamEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

/**
 * Прочитать ответ /api/ai/chat: поток с шагами или обычный JSON (старый
 * сервер, отказ до начала хода). Возвращает тело и статус итога.
 */
export async function readChatAnswer(res: Response, onStep: (label: string) => void): Promise<{ status: number; body: unknown }> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream') || !res.body) {
    return { status: res.status, body: await res.json() };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const e = JSON.parse(line.slice(6)) as ChatStreamEvent;
      if (e.type === 'step') onStep(e.label);
      else if (e.type === 'final') return { status: e.status, body: e.body };
    }
  }
  throw new Error('Поток ответа оборвался без итога');
}
