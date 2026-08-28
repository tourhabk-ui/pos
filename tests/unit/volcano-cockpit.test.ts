/**
 * Volcano OS Cockpit (P3) — read-only наблюдение, не пульт управления.
 *
 * Панель заводилась с одним жёстким условием (модель автономии 27.08):
 * человек принимает ровно одно решение — merge/reject agent-PR В GITHUB.
 * Кокпит это решение ПОКАЗЫВАЕТ, но не исполняет: ни одной мутации ни в
 * API-роуте, ни в клиенте быть не должно. Панель, из которой можно
 * «подтолкнуть» задачу, — это второй операционный путь мимо policy ядра,
 * ровно то, что Kernel v1 закрывал.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prUrlFromResource } from '@/app/hub/admin/volcano/_VolcanoClient';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const API = read('app/api/admin/volcano/route.ts');
const CLIENT = read('app/hub/admin/volcano/_VolcanoClient.tsx');
const LAYOUT = read('app/hub/admin/layout.tsx');

describe('API кокпита: только чтение, только админ', () => {
  it('роут отдаёт ТОЛЬКО GET — других методов нет', () => {
    expect(API).toMatch(/export async function GET/);
    expect(API).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('вход только для админа', () => {
    expect(API).toMatch(/requireAdmin/);
    // Проверка стоит ДО первого запроса к БД.
    expect(API.indexOf('requireAdmin')).toBeLessThan(API.indexOf('pool.query'));
  });

  it('ни одной мутации в SQL — SELECT и только SELECT', () => {
    // Судим по коду без строк-комментариев: проза имеет право упоминать слова.
    const code = API.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/INSERT\s+INTO|UPDATE\s+agent|DELETE\s+FROM|TRUNCATE/i);
  });

  it('task_id проверяется как UUID до запроса — путь из URL не доверенный', () => {
    expect(API).toMatch(/UUID_RE/);
    expect(API.indexOf('UUID_RE.test')).toBeLessThan(API.indexOf('agent_tasks WHERE id'));
  });

  it('отсутствие прогонов Evo — «не было», а не пустая рамка (§4.0)', () => {
    expect(API).toMatch(/last_evo_run: lastEvo\.rows\[0\] \?\? null/);
  });
});

describe('клиент кокпита: наблюдение без кнопок действия', () => {
  it('все fetch — на /api/admin/volcano, без методов мутации', () => {
    const fetches = CLIENT.match(/fetch\([^)]*\)/g) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) {
      expect(f).toContain('/api/admin/volcano');
      expect(f).not.toMatch(/POST|PUT|PATCH|DELETE/);
    }
  });

  it('нет обращений к мутирующим админ-роутам (execute-all, trigger и т.п.)', () => {
    expect(CLIENT).not.toMatch(/execute-all|\/trigger|merge_pull/);
  });

  it('отказ загрузки назван отказом, а не нулями', () => {
    expect(CLIENT).toMatch(/не смогла прочитать/);
    expect(CLIENT).toMatch(/отказ чтения, а не «задач нет»/);
  });

  it('раздел «Ждут моего решения» есть, решение отправляет в GitHub', () => {
    expect(CLIENT).toMatch(/Ждут моего решения/);
    expect(CLIENT).toMatch(/Открыть PR/);
    expect(CLIENT).toMatch(/принимаются в GitHub/);
  });

  it('дизайн — токены и ds-утилиты, без хардкод-hex и эмодзи', () => {
    expect(CLIENT).toMatch(/ds-page/);
    expect(CLIENT).toMatch(/ds-card/);
    expect(CLIENT).toMatch(/var\(--text-primary\)/);
    // Хардкод-цвет в className запрещён (§2); допускается только в токенах.
    expect(CLIENT).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(CLIENT).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe('prUrlFromResource: ссылка на PR из ресурса задачи', () => {
  it('github_pr owner/repo#N → ссылка на pull', () => {
    expect(prUrlFromResource('github_pr', 'tourhabk-ui/pos#1419'))
      .toBe('https://github.com/tourhabk-ui/pos/pull/1419');
  });

  it('чужой тип ресурса или кривой id — null, а не выдуманная ссылка', () => {
    expect(prUrlFromResource('agent_approval', 'abc')).toBeNull();
    expect(prUrlFromResource('github_pr', 'нет-решётки')).toBeNull();
    expect(prUrlFromResource('github_pr', null)).toBeNull();
    expect(prUrlFromResource(null, null)).toBeNull();
  });
});

describe('вход в панель существует', () => {
  it('пункт меню админки ведёт на /hub/admin/volcano', () => {
    // Экран без ссылки в меню — невидимый экран (перепись достижимости 22.08).
    expect(LAYOUT).toMatch(/\/hub\/admin\/volcano/);
    expect(LAYOUT).toMatch(/Работа Volcano OS/);
  });
});
