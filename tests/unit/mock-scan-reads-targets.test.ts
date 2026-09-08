/**
 * Мок-сканер обязан ЧИТАТЬ то, что выбрал.
 *
 * Находка аудита 08.09, и она тотальна. `scanMocks` выбирает цели через
 * `clientComponentPaths` — только `.tsx`. Читает их через `readFileForReview`,
 * а тот шёл в `containedReviewPath`, где первой строкой стояло правило
 * AI-ревью:
 *
 *     if (!p.endsWith('.ts')) return false;
 *
 * То есть КАЖДАЯ цель отвергалась на чтении. Замер на текущем дереве: из 590
 * целей старое правило пропускало 0. `detectMockPatterns` не вызывался ни
 * разу с того дня, как барьер поставили, и «мок-паттернов не найдено»
 * означало «ни один файл не открыли».
 *
 * Хуже: `reviewed.push(f)` стоял ДО проверки содержимого, поэтому журнал
 * покрытия записывал все цели как разобранные. Сканер не читал ничего и
 * отчитывался полным покрытием.
 *
 * Чинить расширением общего правила было нельзя: оно же кормит список файлов
 * для ПЛАТНОГО AI-ревью, и `.tsx` там утроил бы счёт. Поэтому у сканера своё
 * правило, а containment остался общим и обязательным.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isReviewableSourcePath, isScannableClientPath, containedReviewPath,
} from '@/lib/agents/evo/growth-agent';
import { clientComponentPaths } from '@/lib/agents/evo/repo-files';
import * as path from 'node:path';

const SRC = readFileSync('lib/agents/evo/growth-agent.ts', 'utf8');

const SAMPLE_TARGETS = [
  'app/places/[id]/_PlaceClient.tsx',
  'components/homepage/BentoSection.tsx',
  'app/marketplace/tours/[id]/_TourDetailClient.tsx',
];

describe('правило чтения мок-сканера', () => {
  it('старое правило отвергало цели сканера ПОГОЛОВНО', () => {
    // Это и был дефект: не «иногда не читал», а «не читал никогда».
    for (const p of SAMPLE_TARGETS) {
      expect(isReviewableSourcePath(p), p).toBe(false);
    }
  });

  it('новое правило их пропускает', () => {
    for (const p of SAMPLE_TARGETS) {
      expect(isScannableClientPath(p), p).toBe(true);
    }
  });

  it('цели и правило чтения согласованы по построению', () => {
    // Любая цель clientComponentPaths обязана проходить чтение — иначе
    // сканер снова окажется слеп, и снова молча.
    const targets = clientComponentPaths([
      ...SAMPLE_TARGETS,
      'lib/agents/foo.ts',
      'components/x.test.tsx',
    ]);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(isScannableClientPath(t), t).toBe(true);
  });

  it('AI-ревью НЕ расширилось: платный проход остался на .ts', () => {
    expect(isReviewableSourcePath('components/homepage/BentoSection.tsx')).toBe(false);
    expect(isReviewableSourcePath('lib/agents/foo.ts')).toBe(true);
    expect(SRC).toMatch(/export function isScannableClientPath/);
  });

  it('тесты и исключённые файлы не читаются и по новому правилу', () => {
    expect(isScannableClientPath('components/x.test.tsx')).toBe(false);
    expect(isScannableClientPath('app/__tests__/y.tsx')).toBe(false);
    expect(isScannableClientPath('scripts/z.tsx')).toBe(false);
  });
});

describe('containment остался обязательным для всех', () => {
  const root = '/repo';

  it('выход за корень не пускается ни по какому правилу', () => {
    for (const allow of [isReviewableSourcePath, isScannableClientPath]) {
      expect(containedReviewPath('lib/../../etc/passwd.ts', root, path, allow)).toBeNull();
      expect(containedReviewPath('../x.tsx', root, path, allow)).toBeNull();
      expect(containedReviewPath('/etc/passwd.ts', root, path, allow)).toBeNull();
    }
  });

  it('правило допуска по-прежнему проверяется В ТОЧКЕ ЧТЕНИЯ', () => {
    // «Не доверять вызывающему» никуда не делось — изменилось лишь то, что
    // вызывающий называет, КАКОЕ правило применить.
    expect(SRC).toMatch(/if \(!allow\(relPath\)\) return null;/);
    expect(SRC).toMatch(/allow: \(p: string\) => boolean = isReviewableSourcePath/);
  });
});

describe('покрытие пишется по прочитанному, а не по попыткам', () => {
  it('reviewed.push стоит ПОСЛЕ успешного чтения', () => {
    const at = SRC.indexOf('async function scanMocks');
    const body = SRC.slice(at, at + 2200);
    expect(body.indexOf('unread.push(f);')).toBeLessThan(body.indexOf('reviewed.push(f);'));
  });

  it('ноль прочитанных при непустых целях кричит в лог', () => {
    expect(SRC).toContain('мок-сканер не прочитал НИ ОДНОЙ цели');
  });

  it('частичная слепота тоже называется', () => {
    expect(SRC).toContain('часть целей не прочитана');
  });
});
