// @vitest-environment node
/**
 * Прогон разведчика виден в журнале с любой дороги (04.09).
 *
 * Выпуск 04.09 00:02 UTC вышел из оркестратора эволюции (штатный путь с
 * 29.08), а agent_run_history его не видел: журнал вёл только крон-роут.
 * scout-diagnose показывал «последний прогон 03.09 15:59», счёт тишины
 * считал по ручным запускам. Сторож держит: все три дороги идут через
 * runScoutDigestJournaled, дорога записана в metadata.trigger, судьба
 * второго канала — в журнале, а отказ Telegram называет причину словами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const RUN = SRC('lib/agents/scout-digest-run.ts');
const ROUTE = SRC('app/api/cron/scout-digest/route.ts');
const ORCH = SRC('lib/agents/orchestrator.ts');
const ADMIN = SRC('app/api/admin/agents/trigger/route.ts');
const DIGEST = SRC('lib/agents/scout-digest.ts');
const DIAG = SRC('app/api/cron/scout-diagnose/route.ts');

describe('одна дорога в журнал', () => {
  it('крон-роут, оркестратор и админка зовут runScoutDigestJournaled, а не голый runScoutDigest', () => {
    expect(ROUTE).toMatch(/runScoutDigestJournaled\('cron'\)/);
    expect(ORCH).toMatch(/runScoutDigestJournaled\('orchestrator'\)/);
    expect(ADMIN).toMatch(/runScoutDigestJournaled\('admin'\)/);
    for (const [name, src] of [['route', ROUTE], ['orchestrator', ORCH], ['admin', ADMIN]] as const) {
      expect(src, `${name}: голый вызов мимо журнала`).not.toMatch(/\brunScoutDigest\(\)/);
      expect(src, `${name}: свой logAgentRun для scout-digest`).not.toMatch(/agent_id:\s*'scout-digest'/);
    }
  });

  it('журнал знает, кто позвал, и судьбу второго канала', () => {
    expect(RUN).toMatch(/export type ScoutTrigger = 'cron' \| 'orchestrator' \| 'admin'/);
    expect(RUN).toMatch(/metadata:\s*\{\s*trigger,/);
    expect(RUN).toMatch(/ai_channel_sent: result\.ai_channel_sent \?\? null/);
    expect(RUN).toMatch(/ai_channel_skip_reason: result\.ai_channel_skip_reason \?\? null/);
    expect(RUN).toMatch(/ai_channel_skip_detail: result\.ai_channel_skip_detail \?\? null/);
    // Отказ тоже в журнале, с дорогой, и не глотается.
    expect(RUN).toMatch(/status: 'failed'[\s\S]*metadata: \{ trigger \}/);
    expect(RUN).toMatch(/throw err;/);
  });
});

describe('отказ Telegram называет причину', () => {
  it('оба отправителя отдают ответ Bot API или сетевую ошибку через onError', () => {
    expect(DIGEST).toMatch(/function describeTelegramReply\(/);
    expect(DIGEST).toMatch(/async function tgSendTo\(chatId: string, text: string, onError\?: SendErrorSink\)/);
    expect(DIGEST).toMatch(/onError\?: SendErrorSink,\n\): Promise<boolean>/);
    // Ни одного немого catch у отправителей: причина уходит в onError.
    const senders = DIGEST.match(/async function tgSend(?:To|Rich)\([\s\S]*?\n\}/g) ?? [];
    expect(senders.length).toBe(2);
    for (const s of senders) {
      expect(s).not.toMatch(/catch\s*\{\s*return false;\s*\}/);
      expect(s).toMatch(/onError\?\.\(`сеть:/);
      expect(s).toMatch(/if \(!ok\) onError\?\.\(describeTelegramReply\(res\.status, data\)\)/);
    }
  });

  it('улика доезжает до результата, артефакта и диагностики', () => {
    expect(DIGEST).toMatch(/aiSent = await tgSendRich\([^\n]*\(reason\) => \{ aiSkipDetail = reason; \}\)/);
    expect(DIGEST).toMatch(/ai_channel_skip_detail: aiSkipDetail \?\? null/);
    expect(DIGEST).toMatch(/\.\.\.\(aiSkipDetail \? \{ ai_channel_skip_detail: aiSkipDetail \} : \{\}\)/);
    expect(DIGEST).toMatch(/digest_skip_reason: 'telegram_send_failed', \.\.\.\(sendDetail \? \{ digest_skip_detail: sendDetail \} : \{\}\)/);
    expect(DIAG).toMatch(/ai_channel_skip_detail: meta\?\.ai_channel_skip_detail \?\? null/);
    expect(DIAG).toMatch(/trigger: meta\?\.trigger \?\? null/);
  });
});
