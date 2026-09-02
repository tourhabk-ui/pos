// @vitest-environment node
/**
 * Разведка: остаток неподтверждённых фраз вычёркивается, а выпуск уходит
 * (02.09). До этого дня любой остаток после двух переписываний отменял
 * выпуск целиком, и с 17.08 в канал не ушло ничего — при девяти
 * подтверждённых пунктах из десяти каждый прогон.
 *
 * Держит четыре вещи:
 *   1. stripUnsupported исполняется: находит строку по цитате судьи, убирает
 *      её, не трогает заголовки, честно называет ненайденное (unmatched).
 *   2. Судья судит по ПРИНЦИПУ «противоречит или добавляет новое», а не по
 *      дословному присутствию: общеизвестный производитель названного
 *      продукта — не выдумка. Иначе «Anthropic анонсировала Claude…» снова
 *      будет браковаться, как в журнале прогонов августа.
 *   3. Публикатор зовёт вычёркивание ПЕРЕД отменой в обоих каналах, и
 *      отмена остаётся для двух исходов: фразу не нашли, выпуск опустел.
 *   4. Число вычеркнутого доезжает до журнала (route) и до ответа.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripUnsupported, hasSubstance } from '@/lib/agents/fact-check';

const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const FACT = readFileSync(join(ROOT, 'lib/agents/fact-check.ts'), 'utf8');
const DIGEST = strip(readFileSync(join(ROOT, 'lib/agents/scout-digest.ts'), 'utf8'));
const ROUTE = strip(readFileSync(join(ROOT, 'app/api/cron/scout-digest/route.ts'), 'utf8'));

const SAMPLE = [
  '<b>Дайджест 02.09.2026</b>',
  '',
  '<b>AI & Tech</b>',
  '- Anthropic анонсировала модели Claude Fable 5.1 и Claude Mythos 5.1 с расширенными мерами безопасности.',
  '- Cursor выпустил версию 2.4 с фоновыми агентами.',
  '',
  '<b>Туриндустрия</b>',
  '- Ростуризм сообщил о росте внутреннего турпотока летом.',
  '',
  '<b>Камчатка</b>',
  '- Извержение Шивелуча: пепловый шлейф на 8 км, авиационный код красный.',
].join('\n');

describe('1. stripUnsupported исполняется', () => {
  it('находит строку по дословной цитате в «» и убирает её целиком', () => {
    const r = stripUnsupported(SAMPLE, ['«Cursor выпустил версию 2.4 с фоновыми агентами» — в источнике только заголовок без версии']);
    expect(r.dropped).toHaveLength(1);
    expect(r.unmatched).toEqual([]);
    expect(r.text).not.toContain('Cursor');
    expect(r.text).toContain('Anthropic анонсировала');
    expect(r.text).toContain('Шивелуча');
  });

  it('находит строку по пересказу, когда судья не цитировал дословно', () => {
    const r = stripUnsupported(SAMPLE, ['Ростуризм заявил о росте внутреннего турпотока — источник говорит о прогнозе, не о факте']);
    expect(r.dropped).toHaveLength(1);
    expect(r.text).not.toContain('Ростуризм');
  });

  it('пояснение судьи после « — » в сравнении не участвует', () => {
    // Слова пояснения («источник», «упоминается») есть во многих строках;
    // если бы они считались, совпадение уходило бы не туда.
    const r = stripUnsupported(SAMPLE, ['«Извержение Шивелуча: пепловый шлейф на 8 км» — в источнике 6 км']);
    expect(r.dropped).toHaveLength(1);
    expect(r.text).not.toContain('Шивелуча');
    expect(r.text).toContain('Cursor');
  });

  it('фраза, которой в тексте нет, — unmatched, а не «убрали»', () => {
    const r = stripUnsupported(SAMPLE, ['Яндекс запустил нейросеть для бронирования отелей']);
    expect(r.dropped).toEqual([]);
    expect(r.unmatched).toHaveLength(1);
    expect(r.text).toBe(SAMPLE);
  });

  it('заголовки не вычёркиваются, а опустевший раздел получает строку «нет сигналов»', () => {
    const r = stripUnsupported(SAMPLE, ['«Ростуризм сообщил о росте внутреннего турпотока летом»']);
    expect(r.text).toContain('<b>Туриндустрия</b>');
    expect(r.text).toMatch(/<b>Туриндустрия<\/b>\n- Нет значимых сигналов за сегодня/);
    // Заголовок выпуска (первая строка) такой строки не получает.
    expect(r.text).not.toMatch(/<b>Дайджест[^\n]*<\/b>\n- Нет значимых/);
  });

  it('одна строка не вычёркивается дважды за две претензии', () => {
    const r = stripUnsupported(SAMPLE, [
      '«Извержение Шивелуча: пепловый шлейф на 8 км»',
      '«авиационный код красный» — цвета кода в источнике нет',
    ]);
    // Вторая претензия — та же строка; она уже убрана, найти её нельзя.
    expect(r.dropped).toHaveLength(1);
    expect(r.unmatched).toHaveLength(1);
  });

  it('hasSubstance: заголовки и «нет сигналов» — не содержание', () => {
    expect(hasSubstance(SAMPLE)).toBe(true);
    expect(hasSubstance('<b>Дайджест</b>\n\n<b>AI & Tech</b>\n- Нет значимых сигналов за сегодня\n')).toBe(false);
  });
});

describe('2. судья судит по принципу, не по дословности', () => {
  const sys = /const JUDGE_SYSTEM = '([^\n]*)';/.exec(FACT)?.[1] ?? '';

  it('черта названа: противоречит или добавляет новый факт', () => {
    expect(sys).toMatch(/ПРОТИВОРЕЧИТ/);
    expect(sys).toMatch(/НОВЫЙ ФАКТ/);
  });

  it('общеизвестный производитель названного продукта — не выдумка', () => {
    expect(sys, 'судья снова забракует «Anthropic анонсировала Claude»').toMatch(/производител/);
    expect(sys).toMatch(/Anthropic/);
    expect(sys).toMatch(/пересказ/i);
  });

  it('связка, следствие и чужая атрибуция по-прежнему новые факты', () => {
    expect(sys).toMatch(/СВЯЗЬ/);
    expect(sys).toMatch(/СЛЕДСТВИЕ/);
    expect(sys).toMatch(/АТРИБУЦИЯ/);
  });

  it('судью просят цитировать дословно — иначе вычёркивать нечего', () => {
    expect(sys).toMatch(/дословн/);
  });
});

describe('3. публикатор вычёркивает прежде, чем отменить', () => {
  it('дайджест: stripUnsupported стоит перед unsupported_claims, отмена — только unmatched или пусто', () => {
    const at = DIGEST.indexOf("digest_skip_reason: 'unsupported_claims'");
    expect(at).toBeGreaterThan(0);
    const before = DIGEST.slice(Math.max(0, at - 900), at);
    expect(before, 'выпуск снова отменяется целиком из-за остатка').toContain('stripUnsupported(digest, claims)');
    expect(before).toContain('cut.unmatched.length > 0');
    expect(before).toContain('hasSubstance(cut.text)');
    expect(DIGEST).toMatch(/digest = cut\.text/);
  });

  it('AI-канал: та же политика', () => {
    const at = DIGEST.indexOf("aiSkip = 'ai_unsupported_claims'");
    expect(at).toBeGreaterThan(0);
    const before = DIGEST.slice(Math.max(0, at - 600), at);
    expect(before).toContain('stripUnsupported(aiDigest, claims)');
    expect(DIGEST).toMatch(/aiDigest = cut\.text/);
  });
});

describe('4. число вычеркнутого доезжает до журнала', () => {
  it('ответ и журнал несут claims_dropped и детали', () => {
    expect(DIGEST).toMatch(/claims_dropped: claimsDropped/);
    expect(DIGEST).toMatch(/claims_dropped_detail: claimsDroppedDetail/);
    expect(DIGEST).toMatch(/ai_claims_dropped: aiClaimsDropped/);
    expect(ROUTE).toMatch(/claims_dropped: result\.claims_dropped \?\? null/);
  });
});
