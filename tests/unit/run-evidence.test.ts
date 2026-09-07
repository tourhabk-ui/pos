// @vitest-environment node
/**
 * Улики прогона читаются, а не только пишутся (04.09).
 *
 * `agent_run_history.metadata` пишется давно, `GET /api/admin/agents/runs`
 * его возвращает — и до этого дня панель «AI и автоматизации» не показывала
 * его вообще. Разведчик не опубликовал выпуск, журнал знал причину своим
 * кодом, а увидел владелец глазами в канале.
 *
 * Сторож держит три вещи, каждая — про честность, а не про красоту:
 *  1) пустая metadata говорит «не записано», а не молчит зелёным (§4.0);
 *  2) знакомый код пропуска показывается СЛОВАМИ, незнакомый — как есть
 *     (сырой код ищется по репозиторию, «неизвестно» не ищется ничем);
 *  3) панель действительно зовёт разбор — иначе модуль снова станет
 *     писателем без читателя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeRunEvidence } from '@/lib/agents/run-evidence';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-skip-reasons';

const CLIENT = readFileSync(join(process.cwd(), 'app/hub/admin/volcano/_AgentsClient.tsx'), 'utf-8');
const RUNS_API = readFileSync(join(process.cwd(), 'app/api/admin/agents/runs/route.ts'), 'utf-8');

describe('третье состояние журнала', () => {
  it('пустая metadata — «не записано», а не пустой список без объяснения', () => {
    for (const empty of [null, undefined, {}, 'строка', 42, []]) {
      const e = describeRunEvidence(empty);
      expect(e.nothingRecorded, JSON.stringify(empty)).toBe(true);
      expect(e.facts).toHaveLength(0);
    }
  });

  it('поле есть, значения нет — это факт, а не повод скрыть строку', () => {
    const e = describeRunEvidence({ digest_skip_reason: null });
    expect(e.nothingRecorded).toBe(false);
    expect(e.facts[0]!.value).toBe('не записано');
    expect(e.facts[0]!.tone).toBe('muted');
  });
});

describe('коды пропуска — словами', () => {
  it('знакомый код разведчика переводится и сохраняет сам код', () => {
    const e = describeRunEvidence({ ai_channel_skip_reason: 'ai_model_refusal' });
    const fact = e.facts[0]!;
    expect(fact.value).toContain(SKIP_REASON_LABELS.ai_model_refusal);
    expect(fact.value).toContain('ai_model_refusal');
    expect(fact.tone).toBe('alert');
  });

  it('незнакомый код показывается как есть, без слова «неизвестно»', () => {
    const e = describeRunEvidence({ skip_reason: 'zzz_невиданный_код' });
    expect(e.facts[0]!.value).toBe('zzz_невиданный_код');
    expect(e.facts[0]!.value).not.toContain('неизвест');
  });

  it('парный *_detail уходит подписью к своему факту, не отдельной строкой', () => {
    const e = describeRunEvidence({
      ai_channel_skip_reason: 'ai_model_refusal',
      ai_channel_skip_detail: 'заявлена невозможность: «Не вижу текста статьи»',
    });
    expect(e.facts).toHaveLength(1);
    expect(e.facts[0]!.detail).toContain('Не вижу текста статьи');
  });

  it('осиротевший *_detail не теряется молча', () => {
    const e = describeRunEvidence({ digest_skip_detail: 'ленты молчали' });
    expect(e.facts).toHaveLength(1);
    expect(e.facts[0]!.value).toBe('ленты молчали');
  });
});

describe('исходы публикации различимы', () => {
  it('опубликован — хорошо, не опубликован — тревожно', () => {
    expect(describeRunEvidence({ ai_channel_sent: true }).facts[0]!.tone).toBe('good');
    expect(describeRunEvidence({ ai_channel_sent: false }).facts[0]!.tone).toBe('alert');
  });

  it('порядок записи агента сохраняется — он несёт рассказ', () => {
    const e = describeRunEvidence({ trigger: 'orchestrator', signals_found: 12, digest_sent: true });
    expect(e.facts.map(f => f.key)).toEqual(['trigger', 'signals_found', 'digest_sent']);
  });
});

describe('читатель подключён', () => {
  it('API отдаёт metadata, панель её разбирает и показывает', () => {
    expect(RUNS_API).toMatch(/metadata/);
    expect(CLIENT).toMatch(/describeRunEvidence/);
    expect(CLIENT).toMatch(/RunEvidencePanel/);
    expect(CLIENT).toMatch(/metadata: Record<string, unknown> \| null/);
  });
});
