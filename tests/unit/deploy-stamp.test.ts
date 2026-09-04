/**
 * «Тот ли код на проде» — отдельный вопрос от «давно ли перезапускались».
 *
 * 04.09 два замера подряд ушли впустую. Шаг «дождись деплоя» смотрел на
 * uptime процесса и считал деплоем ЛЮБОЙ свежий рестарт — в том числе от
 * предыдущего мержа, выкатывавшегося в те же минуты. Прогон уходил на старом
 * коде и выглядел здоровым: ai-debug run 9 показал таймаут ровно 15 секунд и
 * ни одной новой строки, то есть померил ровно то, что мы за час до этого
 * чинили.
 *
 * Лечится не терпением, а вопросом по существу: время СБОРКИ образа против
 * времени коммита. Штамп ставится в next.config.js в момент `next build` и
 * уезжает в образ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('штамп сборки', () => {
  it('next.config проставляет BUILD_TIME в момент сборки', () => {
    const cfg = read('next.config.js');
    expect(cfg).toMatch(/const BUILD_TIME = new Date\(\)\.toISOString\(\)/);
    expect(cfg).toMatch(/env: \{ BUILD_TIME \}/);
  });

  it('/api/health отдаёт его рядом с uptime, а не вместо', () => {
    const health = read('app/api/health/route.ts');
    expect(health).toMatch(/build_time: process\.env\.BUILD_TIME \?\? null/);
    expect(health).toMatch(/uptime: process\.uptime\(\)/);
  });
});

describe('замеры ждут СВОЮ сборку', () => {
  const workflows = ['.github/workflows/ai-debug.yml', '.github/workflows/cron-scout-digest.yml'];

  it('оба прогона сверяют build_time со временем коммита', () => {
    for (const w of workflows) {
      const src = read(w);
      expect(src, `${w}: не сверяет сборку с коммитом`).toMatch(/NEED_AFTER: \$\{\{ github\.event\.head_commit\.timestamp \}\}/);
      expect(src, `${w}: не читает build_time`).toMatch(/build_time/);
      expect(src, `${w}: нет сравнения BT >= NEED`).toMatch(/\[ "\$BT" -ge "\$NEED" \]/);
    }
  });

  it('старая сборка без штампа не блокирует замер навсегда — есть запасной путь по uptime', () => {
    for (const w of workflows) {
      const src = read(w);
      expect(src, `${w}: нет запасного пути по uptime`).toMatch(/build_time не отдан/);
    }
  });

  it('«не дождались» говорится вслух, а не выдаётся за успех', () => {
    for (const w of workflows) {
      expect(read(w), `${w}: молчаливый выход по таймауту ожидания`).toMatch(/своей сборки не дождались/);
    }
  });
});
