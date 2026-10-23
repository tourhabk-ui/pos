/**
 * Свободный текст от A2A-агента → ответ Кузьмича.
 *
 * Тот же цикл инструментов, что у веб-чата, Telegram и MAX
 * (aiChatAgentLoop + KUZMICH_SYSTEM): один мозг на все каналы, внешний агент
 * видит те же данные, что турист. Разница — одна приписка в системном
 * промпте: отвечаем агенту, а не человеку, без приветствий и без оформления
 * заявок (их агент делает структурированным вызовом с согласием человека).
 *
 * После ответа — один выход ответа Кузьмича на всех каналах
 * (finishKuzmichAnswer, аудит 15.10, 1.14): километраж «от Петропавловска»
 * сверяется с данными хода, утверждения о безопасности — со сводками
 * (#2300), слова о доставке («дошло», «передал оператору») — с инструментами
 * хода (15.10), и при признаках ЧП в вопросе сервер ставит блок 112 — агент
 * может пересказывать слова человека в поле. Ответ замеряется по времени и
 * уходит грейдеру, как на сайте и в мессенджерах.
 *
 * Сбой модели — честный отказ («не смог»), не пустой ответ (§4.0).
 */

import { aiChatAgentLoop, KUZMICH_SYSTEM, isAIErrorResponse } from '@/lib/kuzmich/core';
import { kamchatkaDateContext } from '@/lib/kuzmich/date-context';
import { buildRAGContext } from '@/lib/ai/rag-context';
import { finishKuzmichAnswer } from '@/lib/kuzmich/answer-guards';
import { recordKuzmichAnswer } from '@/lib/kuzmich/answer-timing';
import { newLoopTiming } from '@/lib/kuzmich/answer-ceiling';
import { gradeKuzmichResponse, fingerprintPrompt } from '@/lib/agents/managed/kuzmich-outcomes';
import { KUZMICH_TOOLS } from '@/lib/kuzmich/tool-schemas';
import { logText } from '@/lib/log/log-text';
import type { ToolRun } from '@/lib/agents/eval/grounding';
import type { ChatTurn } from './task-store';

export const A2A_AGENT_NOTE =
  '\n\nТы отвечаешь другому ИИ-агенту по протоколу A2A, а не человеку напрямую: без приветствий и обращений, '
  + 'коротко, фактами из инструментов, на языке вопроса (русский или английский). Если данных в инструментах нет — '
  + 'скажи это прямо. Заявки ты не оформляешь: агент делает их сам структурированным вызовом инструментов '
  + 'create_lead, create_booking_request, create_stay_request, request_charter или create_car_rental_request с согласием человека (consent: true).';

export const A2A_CHAT_FAILED_TEXT =
  'Кузьмич сейчас не смог ответить — это сбой на стороне Ведара, а не «данных нет». '
  + 'Повторите позже или вызовите инструмент напрямую: DataPart {"tool": "<имя>", "arguments": {...}}.';

/**
 * `rejected` у отказа — это не сбой, а «не сейчас» (лимит на адрес): в A2A
 * он становится состоянием rejected, сбой модели — failed.
 */
export type AgentAnswer = { ok: true; text: string } | { ok: false; text: string; rejected?: boolean };

export interface AgentAnswerOptions {
  /** Ключ разговора (contextId A2A): грейдер хэширует его сам. */
  conversationKey?: string | null;
  /** Свой вызов (метка владельца) — вне оценки: это проба, а не спрос. */
  self?: boolean;
}

export async function answerAgentMessage(
  text: string,
  history: ChatTurn[],
  opts: AgentAnswerOptions = {},
): Promise<AgentAnswer> {
  // RAG тот же, что у веб-чата (роль «турист» — туры и места). Его отказ не
  // отменяет ответ: цикл инструментов добудет данные сам, а отказ виден в логе.
  const rag = await buildRAGContext(text, 'tourist').catch((err: unknown) => {
    console.error('[a2a] RAG-контекст не собран:', logText(err instanceof Error ? err.message : err, 200));
    return '';
  });

  const toolRuns: ToolRun[] = [];
  const provenance: { provider?: string } = {};
  const timing = newLoopTiming();
  const startedAt = Date.now();
  let answer: string | null = null;
  try {
    // Вопрос агента — последним сообщением человека. До 13.10 здесь стоял
    // пустой список: вопрос не доходил до модели вовсе, и Кузьмич отвечал
    // про то, что видел в подсказке (пробы 764–766, журнал общения A2A).
    answer = await aiChatAgentLoop(
      text,
      KUZMICH_SYSTEM + A2A_AGENT_NOTE + '\n\n' + kamchatkaDateContext() + '\n\n' + rag,
      history.map((t) => ({ role: t.role, content: t.content })),
      [{ role: 'user', content: text }],
      toolRuns,
      provenance,
      timing,
    );
  } catch (err) {
    console.error('[a2a] цикл инструментов упал:', logText(err instanceof Error ? err.message : err, 300));
  }
  if (!answer || !answer.trim() || isAIErrorResponse(answer)) {
    return { ok: false, text: A2A_CHAT_FAILED_TEXT };
  }

  const finished = finishKuzmichAnswer({
    surface: 'a2a',
    answer,
    question: text,
    toolRuns,
    context: rag,
  });

  void recordKuzmichAnswer({
    surface: 'a2a',
    elapsedMs: Date.now() - startedAt,
    turns: timing.turns,
    toolRounds: timing.toolRounds,
    path: 'tools',
    provider: provenance.provider ?? null,
    ceilingHit: timing.ceilingHit,
  });
  // Ответ внешнему агенту — грейдеру, как с сайта и из мессенджеров: «Кузьмич
  // для агентов» до этого был неизмерим (аудит 15.10, 1.14). Оценивается ответ
  // модели, без поправок и блока 112; ПД, хэш ключа и потолок — в грейдере.
  if (!opts.self) {
    void gradeKuzmichResponse(text, answer, opts.conversationKey ?? null, {
      surface: 'a2a',
      toolRuns,
      promptFingerprint: fingerprintPrompt(KUZMICH_SYSTEM),
      provider: provenance.provider ?? null,
      answerPath: 'tools',
      toolsOffered: KUZMICH_TOOLS.map((t) => t.function.name),
    });
  }

  return { ok: true, text: finished.text };
}
