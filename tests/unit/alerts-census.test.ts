// @vitest-environment node
/**
 * «Тихо в крае» и «молчит конвейер» — разные ответы (04.09).
 *
 * Дайджест напечатал в разделе «Камчатка»: «Нет значимых сигналов за
 * сегодня». Раздел кормится не из RSS, а из нашей таблицы `external_alerts`,
 * значит строка означает: за 25 часов не записано ни одной тревоги. Для
 * Камчатки это неправдоподобно, и та же беда уже была видна с другой стороны
 * (#1485, 30.08: сейсмо-канал отставал на 250 минут).
 *
 * Но по самому дайджесту два состояния неразличимы. Перепись их различает
 * ПАРОЙ фактов: были ли тревоги И ходил ли тот, кто их пишет.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { GET } from '@/app/api/cron/alerts-census/route';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/alerts-census/route.ts'), 'utf-8');

describe('приговор даёт пара фактов, а не одна пустота', () => {
  it('три исхода названы и различимы', () => {
    for (const verdict of ['flowing', 'quiet', 'stalled']) {
      expect(SRC, verdict).toMatch(new RegExp(`'${verdict}'`));
    }
  });

  it('отказ переписи — «не смог», а не «тихо»', () => {
    expect(SRC).toMatch(/verdict: 'unknown'/);
    expect(SRC).toMatch(/console\.error\('\[alerts-census\]/);
  });

  it('пустые сутки судятся вместе с неделей — одни сутки бывают пустыми честно', () => {
    expect(SRC).toMatch(/last_25h/);
    expect(SRC).toMatch(/last_7d/);
  });
});

describe('список наполняющих агентов — из реестра, не из головы', () => {
  it('берётся из CRON_REGISTRY по разряду safety', () => {
    // Первая редакция набрала список руками и назвала `seismic-monitor` и
    // `wildfire-firms` — таких agentId в реестре нет. Тогда «ингест не
    // отмечался» означало бы всего лишь «спрашивал не тех».
    expect(SRC).toMatch(/CRON_REGISTRY/);
    expect(SRC).toMatch(/tier === 'safety'/);
    expect(SRC).not.toMatch(/'seismic-monitor'/);
    expect(SRC).not.toMatch(/'wildfire-firms'/);
  });

  it('в реестре есть кому наполнять таблицу — иначе перепись бессмысленна', () => {
    const safety = CRON_REGISTRY.filter((e) => e.tier === 'safety' && e.agentId);
    expect(safety.length).toBeGreaterThan(0);
    expect(safety.map((e) => e.agentId)).toContain('safety-ingest');
  });

  it('имена наблюдаемых агентов уезжают в ответ — иначе «не отмечался» непроверяемо', () => {
    expect(SRC).toMatch(/ingest_agents_watched/);
  });
});

describe('роут объявлен', () => {
  // 07.09: у переписи появился свой workflow с маркером, и запускающий стал
  // виден из .github/workflows. Объявление «ручная» после этого — второй ответ
  // на один вопрос, и сторож cron-scheduler-declared его не терпит: одна
  // истина, один источник. Поэтому проверяем не запись в реестре ручных, а то,
  // чем эта запись была заменена.
  it('запускающий назван: свой workflow и маркер', () => {
    expect(MANUAL_ENDPOINTS['alerts-census']).toBeUndefined();
    const wf = readFileSync(join(process.cwd(), '.github/workflows/alerts-census.yml'), 'utf-8');
    expect(wf).toContain('.github/triggers/alerts-census.json');
    expect(wf).toContain('/api/cron/alerts-census');
    // Маркер едет тем же пушем, что и код переписи: без ожидания сборки
    // прогон спросил бы вчерашний прод (сторож marker-waits-for-deploy).
    expect(wf).toContain('run: bash scripts/wait-for-deploy.sh');
  });

  it('перепись только читает', () => {
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('секрет сверяется до любого запроса к БД', () => {
    const secretAt = SRC.indexOf('timingSafeCompare');
    const queryAt = SRC.indexOf('pool.query');
    expect(secretAt).toBeGreaterThan(0);
    expect(secretAt).toBeLessThan(queryAt);
  });
});

describe('прогон переписи — приёмка, а не отчёт', () => {
  // 07.09. Об этом дефекте дважды было сказано «починено» раньше, чем
  // результат стало видно, и оба раза строки оставались на главной. Отчёт,
  // который читает человек, такого не ловит: он показывает данные и молчит о
  // том, хороши ли они. Поэтому условие названо машине.
  const WF = readFileSync(join(process.cwd(), '.github/workflows/alerts-census.yml'), 'utf-8');

  it('жанровая запись в ленте красит прогон', () => {
    expect(WF).toContain("a.get('in_feed') and a.get('rejected_genre')");
    expect(WF).toContain('sys.exit(1)');
  });

  it('зелёный говорится словами, а не молчанием', () => {
    // Молчаливый успех неотличим от прогона, который ничего не проверил.
    expect(WF).toContain('ЗЕЛЁНЫЙ');
    expect(WF).toContain('КРАСНЫЙ');
  });
});

describe('спорные записи: отбой по словам, записанный угрозой (#1984)', () => {
  // 21.09 верхней строкой safety_status стояло «Стабилизировалась паводковая
  // обстановка…» с severity 1 — как у настоящих тревог. Классификация не
  // меняется; перепись только называет такие записи, решает человек.
  const SECRET = 'test-cron-secret';
  const req = () => new NextRequest('https://vedarai.ru/api/cron/alerts-census', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  const row = (over: Record<string, unknown>) => ({
    id: '1', title: '', description: '', alert_type: 'flood', severity: 1,
    created_at: '2026-09-21 02:00:00', expires_at: '2026-09-22 02:00:00', push_sent: false,
    ...over,
  });

  function mockLive(live: unknown[]) {
    query.mockImplementation((sql: string) => {
      if (sql.includes('push_sent_at')) return Promise.resolve({ rows: live });
      if (sql.includes('last_25h')) return Promise.resolve({ rows: [{ last_25h: live.length, last_7d: live.length, newest_age_min: 5 }] });
      return Promise.resolve({ rows: [] });
    });
  }

  beforeEach(() => { query.mockReset(); vi.stubEnv('CRON_SECRET', SECRET); });
  afterEach(() => vi.unstubAllEnvs());

  it('отбой в заголовке при severity >= 1 — спорно, и пуш по нему виден', async () => {
    mockLive([
      row({ id: '1', title: 'Стабилизировалась паводковая обстановка в Соболевском округе', push_sent: true }),
      row({ id: '2', title: 'Ожидается паводок на реках западного побережья' }),
    ]);
    const body = await (await GET(req())).json();
    const [standDown, threat] = body.live.alerts;
    expect(standDown.contested).toBe(true);
    expect(standDown.push_sent).toBe(true);
    expect(threat.contested).toBe(false);
    expect(body.live.contested).toBe(1);
  });

  it('отрицание окончания — не спорно: это действующая тревога', async () => {
    mockLive([row({ title: 'Паводковая обстановка не стабилизировалась, уровень воды растёт' })]);
    const body = await (await GET(req())).json();
    expect(body.live.alerts[0].contested).toBe(false);
    expect(body.live.contested).toBe(0);
  });

  it('отбой при severity 0 — не спорно: записан он честно', async () => {
    mockLive([row({ title: 'Снят режим повышенной готовности', alert_type: 'info', severity: 0 })]);
    const body = await (await GET(req())).json();
    expect(body.live.alerts[0].stand_down_title).toBe(true);
    expect(body.live.alerts[0].contested).toBe(false);
  });

  it('важность не записана — спорность неизвестна, а не «чисто» (§4.0)', async () => {
    mockLive([row({ title: 'Очаг возгорания ликвидирован', severity: null })]);
    const body = await (await GET(req())).json();
    expect(body.live.alerts[0].contested).toBeNull();
    expect(body.live.contested).toBe(0);
    expect(body.live.contested_severity_unknown).toBe(1);
  });

  it('слова отбоя только в теле спорности не дают — сводка упоминает прошлые очаги', async () => {
    mockLive([row({
      title: 'Лесной пожар в Мильковском районе',
      alert_type: 'fire',
      description: 'Возник новый очаг. Очаг у села Шаромы ликвидирован накануне.',
    })]);
    const body = await (await GET(req())).json();
    expect(body.live.alerts[0].stand_down_description).toBe(true);
    expect(body.live.alerts[0].contested).toBe(false);
  });

  it('правило отбоя — общее с safety_status, своего списка слов здесь нет', () => {
    expect(SRC).toMatch(/import \{ isResolutionNotice \} from '@\/lib\/safety\/resolution-notice'/);
    expect(SRC).not.toMatch(/стабилизировал\|/);
  });

  it('спорные печатаются в прогоне, но прогон не красят — это улика, не приговор', () => {
    const WF = readFileSync(join(process.cwd(), '.github/workflows/alerts-census.yml'), 'utf-8');
    expect(WF).toContain("a.get('contested') is True");
    const warnAt = WF.indexOf('ВНИМАНИЕ: отбой по словам');
    const exitAt = WF.indexOf('sys.exit(1)');
    expect(warnAt).toBeGreaterThan(0);
    // Печать спорных стоит ДО приёмки жанров: красный её не заслоняет,
    // а своего exit у блока спорных нет.
    expect(warnAt).toBeLessThan(exitAt);
    expect(WF.match(/sys\.exit\(1\)/g)).toHaveLength(1);
  });
});
