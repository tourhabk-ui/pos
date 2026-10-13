/**
 * Свободный текст от A2A-агента → ответ Кузьмича.
 *
 * Тот же цикл инструментов, что у веб-чата, Telegram и MAX
 * (aiChatAgentLoop + KUZMICH_SYSTEM): один мозг на все каналы, внешний агент
 * видит те же данные, что турист. Разница — одна приписка в системном
 * промпте: отвечаем агенту, а не человеку, без приветствий и без оформления
 * заявок (их агент делает структурированным вызовом с согласием человека).
 *
 * После ответа — те же две страховки, что в веб-чате (одно правило на все
 * каналы): сверка утверждений о безопасности с данными хода
 * (guardSafetyClaims, #2300) и серверный блок 112 при признаках ЧП в вопросе
 * (withSosBlock) — агент может пересказывать слова человека в поле.
 *
 * Сбой модели — честный отказ («не смог»), не пустой ответ (§4.0).
 */

import { aiChatAgentLoop, KUZMICH_SYSTEM, isAIErrorResponse } from '@/lib/kuzmich/core';
import { buildRAGContext } from '@/lib/ai/rag-context';
import { guardSafetyClaims } from '@/lib/kuzmich/safety-claim-guard';
import { recordSafetyReview } from '@/lib/kuzmich/safety-review-log';
import { withSosBlock } from '@/lib/safety/sos-detector';
import { logText } from '@/lib/log/log-text';
import type { ToolRun } from '@/lib/agents/eval/grounding';
import type { ChatTurn } from './task-store';

export const A2A_AGENT_NOTE =
  '\n\nТы отвечаешь другому ИИ-агенту по протоколу A2A, а не человеку напрямую: без приветствий и обращений, '
  + 'коротко, фактами из инструментов, на языке вопроса (русский или английский). Если данных в инструментах нет — '
  + 'скажи это прямо. Заявки ты не оформляешь: агент делает их сам структурированным вызовом инструментов '
  + 'create_lead, create_booking_request, create_stay_request или request_charter с согласием человека (consent: true).';

export const A2A_CHAT_FAILED_TEXT =
  'Кузьмич сейчас не смог ответить — это сбой на стороне Ведара, а не «данных нет». '
  + 'Повторите позже или вызовите инструмент напрямую: DataPart {"tool": "<имя>", "arguments": {...}}.';

/**
 * `rejected` у отказа — это не сбой, а «не сейчас» (лимит на адрес): в A2A
 * он становится состоянием rejected, сбой модели — failed.
 */
export type AgentAnswer = { ok: true; text: string } | { ok: false; text: string; rejected?: boolean };

export async function answerAgentMessage(text: string, history: ChatTurn[]): Promise<AgentAnswer> {
  // RAG тот же, что у веб-чата (роль «турист» — туры и места). Его отказ не
  // отменяет ответ: цикл инструментов добудет данные сам, а отказ виден в логе.
  const rag = await buildRAGContext(text, 'tourist').catch((err: unknown) => {
    console.error('[a2a] RAG-контекст не собран:', logText(err instanceof Error ? err.message : err, 200));
    return '';
  });

  const toolRuns: ToolRun[] = [];
  let answer: string | null = null;
  try {
    // Вопрос агента — последним сообщением человека. До 13.10 здесь стоял
    // пустой список: вопрос не доходил до модели вовсе, и Кузьмич отвечал
    // про то, что видел в подсказке (пробы 764–766, журнал общения A2A).
    answer = await aiChatAgentLoop(
      text,
      KUZMICH_SYSTEM + A2A_AGENT_NOTE + rag,
      history.map((t) => ({ role: t.role, content: t.content })),
      [{ role: 'user', content: text }],
      toolRuns,
    );
  } catch (err) {
    console.error('[a2a] цикл инструментов упал:', logText(err instanceof Error ? err.message : err, 300));
  }
  if (!answer || !answer.trim() || isAIErrorResponse(answer)) {
    return { ok: false, text: A2A_CHAT_FAILED_TEXT };
  }

  const guard = guardSafetyClaims(answer, toolRuns);
  if (guard.flagged.length > 0) {
    console.error('[kuzmich-safety-claim-guard] a2a: утверждение о безопасности без опоры', {
      verdict: guard.verdict, flagged: guard.flagged.map((c) => c.phrase),
    });
  }
  void recordSafetyReview('other', guard, toolRuns);

  return { ok: true, text: withSosBlock(guard.text, text).text };
}
