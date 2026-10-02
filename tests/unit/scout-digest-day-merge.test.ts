/**
 * Два выпуска Разведчика в сутки пишут в ОДИН слаг (`intel/scout/<UTC-дата>`),
 * а upsert сливает метаданные. Вечерний выпуск без AI-поста затирал утреннее
 * «ушёл», и health будил «AI-канал молчит» при канале, который сегодня уже
 * получил пост (02.10). Здесь держится, что «ушёл» считается по суткам, а
 * запись журнала не молчит при отказе (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('слаг суток: AI-пост, ушедший утром, не стирается вечером', () => {
  const digest = code(read('lib/agents/scout-digest.ts'));
  const from = digest.indexOf('const slug = `intel/scout/${dateKey}`');
  const block = digest.slice(from, from + 3500);

  it('перед записью читается прежняя запись суток', () => {
    expect(block).toMatch(/knowledgeBase\.get\(slug\)/);
    expect(block).toMatch(/aiSentEarlierToday/);
  });

  it('ai_channel_sent — по суткам, а свой исход прогона лежит отдельно', () => {
    expect(block).toMatch(/ai_channel_sent:\s*aiSentToday/);
    expect(block).toMatch(/ai_channel_sent_by_this_run:\s*aiSent\b/);
  });

  it('причина и деталь остаются фактом этого прогона, а не затираются суточным флагом', () => {
    expect(block).toMatch(/ai_channel_skip_reason:\s*aiSkip \?\? null/);
    expect(block).toMatch(/ai_channel_skip_detail:\s*aiSkipDetail \?\? null/);
  });

  it('запись журнала при отказе не молчит', () => {
    expect(block).not.toMatch(/catch\s*\{\s*\}/);
    expect(block).toMatch(/console\.error\('\[scout-digest\] запись выпуска/);
  });
});

describe('терпение раннера длиннее работы дайджеста', () => {
  it('curl ждёт 900 с: прогон 157 упал на 600-й секунде при выполненной работе', () => {
    const wf = read('.github/workflows/cron-scout-digest.yml');
    expect(wf).toMatch(/--max-time 900[\s\S]{0,80}\/api\/cron\/scout-digest/);
    expect(wf).toMatch(/timeout-minutes:\s*40/);
  });
});
