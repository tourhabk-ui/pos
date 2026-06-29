/**
 * lib/kuzmich/tool-loop.ts
 *
 * Выполнение tool_calls одного хода агент-цикла Кузьмича (Roitman §19.2):
 *  - ПАРАЛЛЕЛЬНО (раньше — последовательно await по одному → суммарная задержка);
 *  - с дедупом по сигнатуре (name+args): модель иногда зацикливается, повторяя
 *    тот же вызов — повтор не исполняем, отдаём короткий short-circuit.
 *
 * Протокол-нейтрально: порядок результатов СОВПАДАЕТ с порядком tool_calls
 * (на каждый tool_call_id нужен tool-ответ), сообщения и id не меняются.
 * Исполнитель инжектируется — модуль чистый и юнит-тестируемый.
 */

import type { ToolCall } from '@/lib/ai/providers';

export interface ToolRunOutcome {
  id: string;
  name: string;
  args: Record<string, string>;
  content: string;
  executed: boolean; // false = дубль, short-circuit (реальный вызов не делался)
}

const DUP_NOTICE = 'Этот запрос уже выполнялся выше — используй полученные данные, не повторяй вызов.';

/** Сигнатура вызова для дедупа: имя + сырые аргументы. */
export function toolSignature(tc: ToolCall): string {
  return `${tc.function.name}:${tc.function.arguments}`;
}

/**
 * Исполняет все tool_calls хода параллельно, сохраняя порядок.
 * @param seen множество уже исполненных сигнатур (живёт между ходами одного цикла)
 * @param exec реальный исполнитель инструмента
 */
export async function runTurnTools(
  toolCalls: ToolCall[],
  seen: Set<string>,
  exec: (name: string, args: Record<string, string>) => Promise<string>,
): Promise<ToolRunOutcome[]> {
  return Promise.all(
    toolCalls.map(async (tc): Promise<ToolRunOutcome> => {
      let args: Record<string, string> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, string>;
      } catch {
        /* пустые/битые аргументы — отдаём {} */
      }

      const sig = toolSignature(tc);
      if (seen.has(sig)) {
        return { id: tc.id, name: tc.function.name, args, content: DUP_NOTICE, executed: false };
      }
      seen.add(sig);

      const content = await exec(tc.function.name, args);
      return { id: tc.id, name: tc.function.name, args, content, executed: true };
    }),
  );
}
