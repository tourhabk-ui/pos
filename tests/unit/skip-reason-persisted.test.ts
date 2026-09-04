/**
 * Свидетельство переживает запрос.
 *
 * `runScoutDigest` считает причину пропуска в восьми точках выхода и отдаёт её
 * в HTTP-ответ. Журнал её не брал. Ответ живёт до конца запроса; крон дёргает
 * GitHub Actions, ответ уходит в лог прогона и через сутки недостижим. Поэтому
 * алерт «Разведчик молчит» умел сказать только «причина — digest_skip_reason в
 * ответе cron/scout-digest», то есть отправить человека дёрнуть крон руками.
 * Тринадцать дней молчания — тринадцать дней, когда причина существовала и
 * была стёрта на выходе.
 *
 * Тот же класс, что каст `::uuid` в чистке жанров (#1165) и голый
 * `.catch(() => {})` в записи heartbeat: работа сделана, следа не осталось.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-digest';
import { formatSkipReason } from '@/app/api/cron/health/route';

const SRC = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('причина пропуска записывается, а не теряется', () => {
  // С 04.09 журнал пишет общий модуль lib/agents/scout-digest-run — им
  // пользуются крон-роут, оркестратор эволюции и админка. Сторож читает
  // модуль, а роут обязан через него идти (см. scout-run-journal.test.ts).
  it('прогон разведчика кладёт причину в журнал', () => {
    const run = SRC('lib/agents/scout-digest-run.ts');
    expect(run).toMatch(/metadata:\s*\{\s*trigger,\s*digest_skip_reason/);
  });

  it('поле есть всегда: отправленный выпуск даёт null, а не отсутствие ключа', () => {
    // Разница существенная: `null` читается как «проверено, причины нет»,
    // отсутствие ключа — как «не записали». Эти два состояния уже путались.
    const run = SRC('lib/agents/scout-digest-run.ts');
    expect(run).toMatch(/digest_skip_reason:\s*result\.digest_skip_reason\s*\?\?\s*null/);
  });

  it('монитор называет причину, а не отсылает за ней в ответ крона', () => {
    const health = SRC('app/api/cron/health/route.ts');
    // Проверяем ПРИСУТСТВИЕ вызова в самом тексте алерта, а не отсутствие
    // старой фразы: первая версия этой проверки запрещала фразу по всему
    // файлу и падала на комментарии, который объясняет, что фраза убрана.
    // Сторож, спотыкающийся о собственное объяснение, — не сторож.
    expect(health).toMatch(/Разведчик молчит:[^`]*\$\{await lastDigestSkipReason\(\)\}/);
    expect(health).toMatch(/agent_id = 'scout-digest'/);
  });
});

describe('словарь причин покрывает все выходы', () => {
  it('у каждой причины из кода есть человеческое имя', () => {
    // Иначе владелец получит в Telegram «all_sections_empty» — для него это
    // то же молчание, только длиннее. Новая причина без имени валит сборку.
    const src = SRC('lib/agents/scout-digest.ts');
    const used = new Set(
      [...src.matchAll(/digest_skip_reason:\s*'([a-z_]+)'/g)].map((m) => m[1]),
    );
    expect(used.size).toBeGreaterThan(0);
    const unnamed = [...used].filter((code) => !(code in SKIP_REASON_LABELS));
    expect(unnamed, `причины без имени: ${unnamed.join(', ')}`).toEqual([]);
  });
});

describe('три исхода различимы', () => {
  it('причина есть — названа словами', () => {
    const s = formatSkipReason({
      metadata: { digest_skip_reason: 'near_repeat' },
      started_at: '2026-08-13T07:00:00Z',
    });
    expect(s).toContain('почти повторял');
    expect(s).toContain('2026-08-13 07:00');
  });

  it('неизвестный код показывается как есть, а не как «неизвестно»', () => {
    // Сырой код — след, по которому находят место в исходнике. Слово
    // «неизвестно» стирает и его.
    const s = formatSkipReason({
      metadata: { digest_skip_reason: 'brand_new_reason' },
      started_at: '2026-08-13T07:00:00Z',
    });
    expect(s).toContain('brand_new_reason');
  });

  it('прогон был, а причины нет — это отдельный ответ', () => {
    // Пропуск без записанной причины сам по себе дефект, и он не должен
    // выглядеть как «крон не запускался».
    const s = formatSkipReason({ metadata: null, started_at: '2026-08-13T07:00:00Z' });
    expect(s).toMatch(/причину не записал/);
  });

  it('прогонов нет вовсе — сказано прямо', () => {
    // «Не запускался» и «запускался и промолчал» лечатся по-разному.
    expect(formatSkipReason(null)).toMatch(/не запускался/);
  });
});

describe('запись heartbeat не молчит о своём провале', () => {
  it('провал INSERT попадает в лог, а не в пустой catch', () => {
    // Молча проглоченный провал означал бы: приём отработал, записи нет,
    // монитор доложил «молчит» — и снова показал не туда.
    //
    // Смотрим ТЕЛО logHeartbeat, а не весь файл: в роуте есть законные
    // `.catch(() => {})` на отправке в Telegram, и запрет по всему файлу
    // объявил бы дефектом их. Правило узкое: молчать нельзя тому шагу,
    // который пишет свидетельство о работе.
    const src = SRC('app/api/cron/safety-ingest/route.ts');
    const body = src.match(/function logHeartbeat[\s\S]*?\n\}/)?.[0] ?? '';
    expect(body, 'logHeartbeat не найдена').not.toBe('');
    expect(body).not.toMatch(/\.catch\(\(\) => \{\}\)/);
    expect(body).toMatch(/console\.error/);
    expect(body).toMatch(/heartbeat НЕ записан/);
  });

  it('но наверх не бросает: сбой журнала не имеет права уронить приём', () => {
    // Обратная ошибка того же места — уже пройдена (тревога 3805 минут).
    const src = SRC('app/api/cron/safety-ingest/route.ts');
    expect(src).toMatch(/logHeartbeat\(startedAt, durationMs/);
    expect(src).not.toMatch(/await logHeartbeat\(/);
  });
});
