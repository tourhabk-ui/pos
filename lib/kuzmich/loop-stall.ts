/**
 * lib/kuzmich/loop-stall.ts — где цикл инструментов Кузьмича застревает
 * (решение 01.11, карт-бланш владельца после разбора «супервизора ролей»).
 *
 * Предложение было: модель-супервизор читает сессии, сочиняет «недостающую
 * роль» и сама подмешивает её в системный промпт Кузьмича. Отказались: живой
 * промпт, который пишет модель без человека, на пути, где турист спрашивает
 * про безопасность в поле, — это Editor 22.10, только хуже. Взяли из идеи то,
 * что считается без модели: признаки застревания самого цикла.
 *
 * Четыре признака, все — факты хода, а не оценка:
 *   - повторный вызов: модель снова зовёт инструмент с теми же аргументами,
 *     хотя ответ уже лежит выше (цикл отдаёт ей заглушку, не исполняет);
 *   - неверные аргументы: валидатор отверг вызов;
 *   - инструмент упал: исполнение кончилось исключением;
 *   - ходы кончились: цикл истратил все ходы и ответа не дал (дальше отвечает
 *     запасной путь без инструментов).
 *
 * Пишется в замер ответа (lib/kuzmich/answer-timing) — только числа и имена
 * инструментов, ни слова реплик (pd-guard). Читает линза эволюции
 * (lib/agents/evo/kuzmich-stall-lens): доля застреваний выше порога → находка
 * → GitHub Issue → правка кода человеком или Claude Code. В промпт отсюда не
 * идёт ничего.
 */

import type { ToolRunOutcome } from '@/lib/kuzmich/tool-loop';
import { TOOL_EXECUTION_FAILED } from '@/lib/kuzmich/tool-failure';

export interface LoopStall {
  /** Вызовов, повторивших уже исполненный в этом ответе. */
  dupCalls: number;
  /** Вызовов, отвергнутых валидатором аргументов. */
  invalidArgs: number;
  /** Исполненных вызовов, упавших внутри инструмента. */
  toolFailures: number;
  /** Цикл истратил все ходы, не дав ответа. */
  turnsExhausted: boolean;
  /** Имена инструментов, на которых случился любой признак выше (без повторов). */
  tools: string[];
}

/** Сколько имён инструментов хранить в одной записи: хватает на разбор, не раздувает журнал. */
export const STALL_TOOLS_MAX = 5;

export function newLoopStall(): LoopStall {
  return { dupCalls: 0, invalidArgs: 0, toolFailures: 0, turnsExhausted: false, tools: [] };
}

function noteTool(stall: LoopStall, name: string): void {
  if (stall.tools.length < STALL_TOOLS_MAX && !stall.tools.includes(name)) stall.tools.push(name);
}

/** Добавить признаки одного хода инструментов. */
export function tallyTurnStall(stall: LoopStall, outcomes: readonly ToolRunOutcome[]): void {
  for (const o of outcomes) {
    if (o.skipped === 'duplicate') {
      stall.dupCalls += 1;
      noteTool(stall, o.name);
    } else if (o.skipped === 'invalid_args') {
      stall.invalidArgs += 1;
      noteTool(stall, o.name);
    } else if (o.executed && o.content === TOOL_EXECUTION_FAILED) {
      stall.toolFailures += 1;
      noteTool(stall, o.name);
    }
  }
}

/**
 * Признаки для замера ответа. Цикл не ходил ни разу — признаков нет вовсе
 * (null), а не нули: «не застревал» и «не запускался» — разные факты.
 */
export function answerStall(timing: { turns: number; stall: LoopStall }): LoopStall | null {
  return timing.turns > 0 ? timing.stall : null;
}

/** Поля замера ответа. Только числа и имена инструментов. */
export function stallMetadata(stall: LoopStall | null | undefined): Record<string, number | boolean | string[]> {
  if (!stall) return {};
  return {
    stall_dup_calls: stall.dupCalls,
    stall_invalid_args: stall.invalidArgs,
    stall_tool_failures: stall.toolFailures,
    stall_turns_exhausted: stall.turnsExhausted,
    stall_tools: stall.tools,
  };
}
