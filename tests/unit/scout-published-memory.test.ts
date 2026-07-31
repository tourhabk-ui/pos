/**
 * Канал не повторяет уже опубликованное.
 *
 * Находка 31.07 (владелец: «почему модели новости повторяют в канале?»):
 * межпрогонный фильтр режет повторные сигналы по URL и Jaccard≥0.5 заголовка,
 * но перепечатка другими словами делит с оригиналом 2-3 токена из десяти и
 * проходит. Дальше в промпте стояло «не дублировать уже выданные инсайты»,
 * а recentRuns содержал только метаданные («07:00 — success») — модель не
 * видела ни слова из вчерашнего выпуска, хотя каждый выпуск ХРАНИТСЯ в
 * agent_knowledge (intel/scout/<дата>). Третий случай болезни write-only.
 *
 * Два эшелона: тексты выпусков — модели в промпт (вероятностный) и
 * детерминированный предохранитель на выходе (почти дословный повтор не
 * уходит подписчикам). Сторож держит чистые функции и подключение обоих.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  publishedDigestsBlock,
  isNearRepeatOfPrevious,
  REPEAT_DIGEST_THRESHOLD,
} from '@/lib/agents/scout-digest';

const DIGEST_A = `<b>Дайджест 30.07.2026</b>

<b>AI &amp; Tech</b>
- Claude Code получил фоновые задачи и планировщик агентов
- Cursor добавил локальный индекс монорепозиториев

<b>Туриндустрия</b>
- Trip.com отключила инструмент в центре антимонопольного дела

<b>Камчатка</b>
- Открылась регистрация на Берингию, ожидают рекорд участников`;

const DIGEST_B = `<b>Дайджест 31.07.2026</b>

<b>AI &amp; Tech</b>
- OpenAI выпустила инструмент проверки фактов для новостных лент

<b>Туриндустрия</b>
- РСТ предложил единый реестр гидов-проводников

<b>Камчатка</b>
- На Ключевской объявлен жёлтый код авиационной опасности`;

describe('publishedDigestsBlock: выпуски канала — модели в промпт', () => {
  it('пусто на входе — пустая строка, промпт без заглушек', () => {
    expect(publishedDigestsBlock([])).toBe('');
    expect(publishedDigestsBlock(['', '   '])).toBe('');
  });

  it('содержит инструкцию и тексты обоих выпусков', () => {
    const block = publishedDigestsBlock([DIGEST_A, DIGEST_B]);
    expect(block).toContain('УЖЕ ОПУБЛИКОВАНО В КАНАЛЕ');
    expect(block).toContain('НЕ пересказывай');
    expect(block).toContain('антимонопольного дела');
    expect(block).toContain('жёлтый код');
  });

  it('повтор при развитии сюжета разрешён явно — новость не глушится навсегда', () => {
    expect(publishedDigestsBlock([DIGEST_A])).toContain('РАЗВИТИИ сюжета');
  });

  it('потолок по символам соблюдается', () => {
    const block = publishedDigestsBlock(['x'.repeat(9000)], 400);
    expect(block.length).toBeLessThanOrEqual(400);
    expect(block.endsWith('…')).toBe(true);
  });
});

describe('isNearRepeatOfPrevious: детерминированный предохранитель на выходе', () => {
  it('тот же выпуск (модель проигнорировала промпт) — блок', () => {
    expect(isNearRepeatOfPrevious(DIGEST_A, [DIGEST_A])).toBe(true);
  });

  it('честный свежий выпуск проходит: общие заголовки разделов — не повтор', () => {
    expect(isNearRepeatOfPrevious(DIGEST_B, [DIGEST_A])).toBe(false);
  });

  it('пустая история — не блокирует ничего', () => {
    expect(isNearRepeatOfPrevious(DIGEST_A, [])).toBe(false);
    expect(isNearRepeatOfPrevious(DIGEST_A, ['', '  '])).toBe(false);
  });

  it('порог консервативный: съесть живой выпуск дороже, чем пропустить повтор', () => {
    expect(REPEAT_DIGEST_THRESHOLD).toBeGreaterThanOrEqual(0.6);
  });
});

describe('память канала подключена в исходниках', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
  const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const src = code(read('lib/agents/scout-digest.ts'));

  it('выпуски читаются из agent_knowledge и попадают в промпт синтеза', () => {
    expect(src, 'модель снова не видит вчерашний выпуск — чтение отвалилось')
      .toMatch(/recentPublishedDigests\(\)/);
    expect(src).toMatch(/publishedDigestsBlock\(publishedDigests\)/);
  });

  it('предохранитель стоит перед отправкой', () => {
    expect(src, 'почти дословный повтор снова уйдёт подписчикам')
      .toMatch(/isNearRepeatOfPrevious\(digest, publishedDigests\)/);
    expect(src).toMatch(/repeat_blocked: true/);
  });
});
