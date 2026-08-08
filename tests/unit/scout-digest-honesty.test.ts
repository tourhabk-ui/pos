/**
 * Дайджест не выдумывает и не публикует пустоту.
 *
 * Инцидент 25.07.2026. В дайджест ушло: «Claude Opus 5 — новая версия <...>
 * без изменения цены». Цена изменилась вдвое — Opus 5 стоит половину Fable 5.
 * Рядом стояли «OpenAI готовит революцию в IT — стоит следить за обновлениями»
 * (нулевая информативность) и два раздела «Нет значимых сигналов за сегодня».
 *
 * Причина оказалась структурной, а не разовой. Пост в AI-канал давно защищён:
 * там и «ГЛАВНОЕ ПРАВИЛО — НЕ ВРАТЬ», и два фактчек-гейта, и отказ публиковать
 * при непройденном фактчеке. У ОСНОВНОГО дайджеста не было ничего из этого —
 * при том, что он идёт по тому же коду и той же моделью. Защита существовала,
 * но только на одной из двух веток.
 */
import { describe, it, expect } from 'vitest';
import { unsourcedPercents } from '@/lib/agents/scout-digest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');

describe('числовой гейт: процент без источника — выдумка', () => {
  it('процента нет в сигналах — ловится', () => {
    expect(unsourcedPercents('Скорость выросла на 40%.', 'Вышла новая версия')).toEqual(['40%']);
  });

  it('процент есть в сигналах — пропускается', () => {
    expect(unsourcedPercents('Скорость выросла на 40%.', 'ускорение до 40 процентов')).toEqual([]);
  });

  it('диапазон проверяется по обоим числам', () => {
    expect(unsourcedPercents('на 10-20%', 'прирост 20 пунктов')).toEqual([]);
    expect(unsourcedPercents('на 10-20%', 'ничего числового')).toEqual(['10-20%']);
  });

  it('запятая и точка в дроби — одно число', () => {
    expect(unsourcedPercents('рост 2,5%', 'рост 2.5 процента')).toEqual([]);
  });

  it('текст без процентов претензий не вызывает', () => {
    expect(unsourcedPercents('Вышла новая модель.', 'источник')).toEqual([]);
  });
});

describe('основной дайджест защищён так же, как пост в AI-канал', () => {
  // Тело функции сборки дайджеста — до постановки в очередь на отправку.
  const body = SRC.match(/Все разделы пусты[\s\S]*?const sent = await tgSend\(digest\)/)?.[0] ?? '';

  it('участок с гейтами найден', () => {
    expect(body).not.toBe('');
  });

  it('пустой дайджест не публикуется', () => {
    // Раньше здесь стоял tgSend(digest) — и «Нет значимых сигналов» x3 уходило
    // в канал. Проверяем, что в ветке allEmpty отправки нет.
    const emptyBranch = body.match(/if \(allEmpty\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(emptyBranch).not.toBe('');
    expect(emptyBranch).not.toMatch(/tgSend/);
    expect(emptyBranch).toMatch(/digest_sent: false/);
  });

  it('оба гейта стоят на пути основного дайджеста', () => {
    expect(body).toMatch(/unsourcedPercents\(digest/);
    expect(body).toMatch(/unsupportedClaims\(digest/);
  });

  it('непройденный фактчек означает отказ от публикации, а не публикацию как есть', () => {
    // Обе проверки после переписи обязаны вести к выходу без отправки.
    const refusals = body.match(/digest_sent: false/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(3); // пустой + два гейта
  });
});

describe('промпт запрещает додумывать и натягивать связь', () => {
  it('есть прямой запрет на факты вне сигналов', () => {
    expect(SRC).toMatch(/НЕ ВРАТЬ/);
    expect(SRC).toMatch(/ДОСЛОВНО из сигнала/);
  });

  it('цены названы отдельно — на них и споткнулись', () => {
    expect(SRC).toMatch(/без изменения цены/);
  });

  it('натянутая привязка к платформе запрещена явно', () => {
    expect(SRC).toMatch(/Натянутая привязка/);
  });
});

describe('немых выходов больше нет: каждый пропуск выпуска называет причину (07-08.08)', () => {
  // Крон разведчика был success ежедневно, а дайджеста не было с 01.08 —
  // шесть выходов digest_sent:false не несли причины, и неделю тишины не
  // заметил никто. Сторож: любой return с digest_sent: false обязан нести
  // digest_skip_reason (кроме случаев с условным спредом telegram_send_failed).
  const SRC = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');

  it('каждый return с digest_sent: false несёт digest_skip_reason', () => {
    const falseReturns = SRC.split('\n').filter((l) => l.includes('digest_sent: false'));
    expect(falseReturns.length).toBeGreaterThanOrEqual(7);
    for (const line of falseReturns) {
      expect(line, `немой выход: ${line.trim()}`).toMatch(/digest_skip_reason/);
    }
  });

  it('неотправленный телеграм тоже назван (условный спред при digest_sent: sent)', () => {
    expect((SRC.match(/digest_skip_reason: 'telegram_send_failed'/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('health следит за свежестью дайджеста по артефакту', () => {
    const HEALTH = readFileSync(join(process.cwd(), 'app/api/cron/health/route.ts'), 'utf-8');
    expect(HEALTH).toMatch(/Разведчик молчит/);
    expect(HEALTH).toMatch(/intel\/scout\//);
  });
});
