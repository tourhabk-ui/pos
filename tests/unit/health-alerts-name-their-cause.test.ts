/**
 * Два алерта владельца 02.10 («AI-канал молчит… модель не вернула AI-пост» и
 * «КФ ЕГС — землетрясения: ни разу не дал данных (скрейп/парс сломан?)»)
 * повторялись часами и не говорили, ПОЧЕМУ. Здесь держится, что причина теперь
 * называется и что принятое молчание не будит (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SAFETY_SOURCE_EXPECTATIONS,
  splitKnownDormant,
  type DeadSource,
} from '@/lib/services/safety/source-health';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('emsd.ru: известное состояние, а не «парс сломан»', () => {
  it('emsd_quakes записан как knownDormant с причиной и датой', () => {
    const e = SAFETY_SOURCE_EXPECTATIONS.find((x) => x.key === 'emsd_quakes');
    expect(e?.knownDormant?.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e?.knownDormant?.reason).toMatch(/403/);
  });

  it('мёртвый emsd_quakes уходит в «известные», а не в будящий алерт', () => {
    const dead = [{ key: 'emsd_quakes', label: 'КФ ЕГС', reason: 'never' } as unknown as DeadSource];
    const { alertable, known } = splitKnownDormant(dead, SAFETY_SOURCE_EXPECTATIONS);
    expect(alertable).toHaveLength(0);
    expect(known).toHaveLength(1);
  });

  it('другой мёртвый источник по-прежнему будит (принятие узкое)', () => {
    const dead = [{ key: 'eqkam', label: 'EQKam', reason: 'silent' } as unknown as DeadSource];
    const { alertable } = splitKnownDormant(dead, SAFETY_SOURCE_EXPECTATIONS);
    expect(alertable).toHaveLength(1);
  });

  it('запрос к emsd.ru идёт с браузерным user-agent, а не голым Node', () => {
    const src = read('lib/services/safety/emsd-fetch.ts');
    expect(src).toMatch(/headers:\s*\{[^}]*'user-agent'/s);
  });
});

describe('AI-канал: перед сдачей один повтор синтеза', () => {
  const digest = read('lib/agents/scout-digest.ts');
  const from = digest.indexOf('let aiDigest = await callAIQualityOrNull(aiMessages');
  // Без комментариев: соседний комментарий сам называет прежний голый catch.
  const synth = digest
    .slice(from, digest.indexOf("aiSkip = 'ai_synthesis_null'", from) + 200)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('вызов синтеза стоит дважды, и размышление остаётся включённым', () => {
    expect(synth.match(/callAIQualityOrNull\(aiMessages/g)?.length).toBe(2);
    expect(synth).not.toMatch(/deepThinking:\s*false/);
  });

  it('отказ повтора не глотается пустым catch', () => {
    expect(synth).not.toMatch(/\.catch\(\(\)\s*=>\s*null\)/);
  });
});
