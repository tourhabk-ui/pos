/**
 * Сторож: причина отказа судьи не схлопывается в пути публикации.
 *
 * ── Дефект, который здесь заперт ──────────────────────────────────────────
 *
 * У судьи фактгейта шесть ИМЕНОВАННЫХ причин отказа (JudgeFailure): молчит
 * провайдер, не ответил никто, проза вместо JSON, обрыв по токенам, нет
 * нужного поля, запрос упал. Тонкая обёртка `unsupportedClaims` схлопывает
 * их все в один `null`.
 *
 * Первая сверка выпуска причину называла точно. А ПОВТОРНАЯ — после
 * переписывания — звалась через обёртку, и любой её отказ доезжал до отчёта
 * как `factcheck_judge_mute` («проверяющая модель не ответила»). При мёртвых
 * провайдерах владельца отправляли чинить промпт. Это тот же дефект, что
 * чинили 22.08 в самом судье и 23.08 в тексте алерта — он вернулся третьим
 * местом, потому что нигде не был заперт.
 *
 * У канала @ai_hub_money было хуже: отказ судьи и оставшаяся выдумка давали
 * ОДИН код `ai_factcheck_failed`. По нему нельзя понять, чинить провайдеров
 * или содержание, — а для молчащего канала это единственная подсказка.
 *
 * Проверка структурная: вызвать конвейер целиком — это RSS, БД и две модели.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-digest';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf8');
/** Код без комментариев: в них эти же слова стоят как объяснение, а не как вызов. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('судья: причина отказа доезжает до отчёта', () => {
  it('unsupportedClaims не зовётся из дайджеста — обёртка теряет причину', () => {
    expect(
      CODE.includes('unsupportedClaims('),
      'вернулся вызов unsupportedClaims: он схлопывает шесть причин в null, ' +
      'используй judgeClaims и назови причину через judgeSkipReason',
    ).toBe(false);
  });

  it('judgeClaims зовётся не один раз — и первая сверка, и повторная', () => {
    const calls = CODE.match(/judgeClaims\(/g) ?? [];
    expect(
      calls.length,
      'повторная сверка после переписывания обязана звать judgeClaims, а не обёртку',
    ).toBeGreaterThanOrEqual(3);
  });

  it('исход судьи превращается в ИМЕННОЙ код, а не в общий ярлык', () => {
    // Дайджест — через judgeSkipReason, канал — через карту AI_JUDGE_SKIP.
    // Карта литеральная намеренно: собранное строкой имя не видно ни
    // читателю, ни сторожу ai-channel-observable.
    expect((CODE.match(/judgeSkipReason\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((CODE.match(/AI_JUDGE_SKIP\[/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('карта причин канала покрывает все шесть отказов судьи', () => {
    // Record<JudgeFailure, string> поручает полноту компилятору, но литералы
    // должны быть видны и глазом — иначе код, который агент способен выдать,
    // нигде не написан.
    const map = /const AI_JUDGE_SKIP: Record<JudgeFailure, string> = \{[\s\S]*?\};/.exec(SRC)?.[0] ?? '';
    for (const why of ['silent', 'unavailable', 'unparseable', 'truncated', 'bad_shape', 'threw']) {
      expect(map, `в карте канала нет отказа ${why}`).toContain(`ai_judge_${why}`);
    }
  });

  it('канал больше не сваливает отказ судьи и выдумку в один код', () => {
    // `ai_factcheck_failed` остаётся в словаре ради старых записей журнала,
    // но НОВЫХ присвоений этого кода в коде быть не должно.
    expect(
      /aiSkip\s*=\s*'ai_factcheck_failed'/.test(CODE),
      'канал снова присваивает общий ai_factcheck_failed — по нему нельзя ' +
      'понять, чинить провайдеров или содержание поста',
    ).toBe(false);
  });

  it('у канала есть отдельный код для оставшейся выдумки', () => {
    expect(CODE).toMatch(/aiSkip\s*=\s*'ai_unsupported_claims'/);
    expect(SKIP_REASON_LABELS.ai_unsupported_claims).toBeTruthy();
  });

  it('каждая причина судьи названа словами и для канала тоже', () => {
    for (const why of ['silent', 'unavailable', 'unparseable', 'truncated', 'bad_shape', 'threw']) {
      const key = `ai_judge_${why}`;
      expect(SKIP_REASON_LABELS[key], `код ${key} без человеческого имени`).toBeTruthy();
      expect(SKIP_REASON_LABELS[key]).not.toBe(key);
    }
  });

  it('synthesis_null несёт след отказов провайдеров', () => {
    // Иначе код называет исход («текста нет»), но не причину, а причин две с
    // разным лечением: модель ответила пустотой или не ответил никто.
    const at = CODE.indexOf("digest_skip_reason: 'synthesis_null'");
    expect(at).toBeGreaterThan(0);
    const around = CODE.slice(Math.max(0, at - 400), at + 200);
    expect(around).toContain('describeRecentAiFailures');
  });
});
