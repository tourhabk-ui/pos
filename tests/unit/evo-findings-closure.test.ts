/**
 * Закрытие списка находок эволюции говорит РОВНО то, что произошло.
 *
 * 23.08 владелец сказал «удали все оттуда» после разбора судьёй. Разбор
 * дал 0 настоящих дефектов из 17, а перепись прода (проба 186) показала,
 * что в списке не 41 запись, а больше сотни: судья смотрел окно семи
 * дней, панель окна не имеет. То есть закрывать пришлось и то, чего никто
 * не читал.
 *
 * Здесь легко соврать двумя разными способами, и оба тихие.
 *
 * Первый — назвать неразобранное ложью. У статуса есть цена: 'rejected'
 * идёт в счёт точности эволюции как промах модели И глушит класс
 * претензии на файле навсегда. Поставить его находке, которую не читали,
 * значит записать «не разбирал» как «отверг».
 *
 * Второй — глушить класс по любому закрытию. Пока стоп-лист читал и
 * 'ignored', массовая уборка списка заглушила бы сотню классов претензий
 * на сотне файлов, и заметить это было бы нечем: заглушенный класс не
 * оставляет следа, в отличие от лишнего повтора.
 *
 * Сторож держит оба края.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVO_ISSUE_STATUSES } from '@/lib/agents/evo/feedback-loop';

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf-8');
}

const MIGRATION = read('migrations/912_close_evo_findings_by_owner.sql');
const GROWTH = read('lib/agents/evo/growth-agent.ts');

/** Тело SQL без строк-комментариев: судим по действиям, а не по прозе. */
const SQL = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('миграция закрытия списка', () => {
  it('ставит только те статусы, которые считаются', () => {
    const set = new Set(EVO_ISSUE_STATUSES as readonly string[]);
    const used = [...SQL.matchAll(/SET status = '([a-z_]+)'/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const s of used) expect(set.has(s)).toBe(true);
  });

  it('не ставит статус fixed', () => {
    // getEvoStats его не считает вовсе — строка ушла бы из всех счётчиков
    // разом. Ровно та «мёртвая цифра», ради которой писан evo-stats-honesty.
    expect(SQL).not.toMatch(/SET status = 'fixed'/);
  });

  it('ложью названы только те шесть, которые судья опроверг', () => {
    const rejectedBlock = SQL.slice(
      SQL.indexOf("SET status = 'rejected'"),
      SQL.indexOf("SET status = 'ignored'"),
    );
    // Шесть пар «файл — заголовок», и ни одной больше.
    expect((rejectedBlock.match(/^\s*\('/gm) ?? []).length).toBe(6);
  });

  it('неразобранное закрывается как «не берём», а не как «ложь»', () => {
    // Общее условие ровно одно и без списка файлов: список id тут был бы
    // враньём о полноте — роут переписи упёрся в собственный потолок.
    const blanket = SQL.slice(SQL.lastIndexOf("SET status = 'ignored'"));
    expect(blanket).toMatch(/WHERE status IN \('open', 'suggested'\)/);
    expect(blanket).not.toMatch(/file_path/);
  });

  it('общее закрытие идёт ПОСЛЕ поимённых — иначе оно съест их первым', () => {
    const accepted = SQL.indexOf("SET status = 'accepted'");
    const rejected = SQL.indexOf("SET status = 'rejected'");
    const blanket = SQL.lastIndexOf("SET status = 'ignored'");
    expect(accepted).toBeGreaterThan(-1);
    expect(rejected).toBeGreaterThan(accepted);
    expect(blanket).toBeGreaterThan(rejected);
  });

  it('в комментариях нет точки с запятой', () => {
    // Миграция 843 упала на проде именно так: «;» внутри комментария
    // разрезал файл посреди инструкции.
    const comments = MIGRATION.split('\n').filter((l) => l.trim().startsWith('--'));
    for (const line of comments) expect(line).not.toMatch(/;/);
  });
});

describe('стоп-лист классов претензий', () => {
  const block = GROWTH.slice(
    GROWTH.indexOf('async function loadRejectedSignatures'),
    GROWTH.indexOf('async function loadRejectedSignatures') + 700,
  );

  it('молчание класса покупается только явным «ложь»', () => {
    expect(block).toMatch(/WHERE status = 'rejected'/);
  });

  it('«не берём в работу» класс не глушит', () => {
    expect(block).not.toMatch(/'ignored'/);
  });
});
