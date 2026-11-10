/**
 * Данные группы из слоя «Регистрация в МЧС» наружу не уходят (аудит 10.11).
 *
 * До 10.11 роут /api/operator/mchs-registrations звал registerGroupWithMchs,
 * которая POST-ила состав группы (ФИО, телефоны, даты рождения, контакты) на
 * адрес из env MCHS_API_URL. Переменная не была задана, и функция всегда
 * отвечала «не настроено». Но стоило бы кому-то её задать — ПД туристов ушли
 * бы на этот адрес без основания для такой передачи.
 *
 * Отправка удалена вместе с роутом и клиентом: экрана у роута не было, а
 * принимать и хранить состав группы с телефонами он продолжал (ревью PR 3188).
 * Первая редакция сторожа проверяла только этот роут — то есть зеленела бы,
 * появись отправка в соседнем файле. Теперь держит три вещи:
 *
 *  1. удалённые файлы и переменные не вернулись;
 *  2. запрет: серверный код слоя МЧС не ходит в сеть сам;
 *  3. вызовом: живой роут кабинета оператора при заданном адресе сети не
 *     трогает и говорит подать заявку самому.
 *
 * Единственный разрешённый выход — письмо на ящик Ведара
 * (lib/safety/mchs-letter); его получателя держит tests/unit/mchs-letter.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.query(...a) }));
vi.mock('@/lib/auth/middleware', () => ({ requireOperator: async () => ({ userId: 'u1', role: 'operator' }) }));
vi.mock('@/lib/auth/operator-helpers', () => ({ getOperatorPartnerId: async () => 'p1' }));

const { POST } = await import('@/app/api/operator/mchs/register/route');

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry.startsWith('.next')) continue;
    const p = join(abs, entry);
    if (statSync(p).isDirectory()) out.push(...walk(relative(ROOT, p), keep));
    else if (keep(entry)) out.push(relative(ROOT, p));
  }
  return out;
}

const isCode = (f: string) => /\.(ts|tsx|mjs|js)$/.test(f);

describe('удалённый путь наружу не вернулся', () => {
  it.each([
    'lib/safety/mchs-client.ts',
    'app/api/operator/mchs-registrations/route.ts',
  ])('%s удалён', (f) => {
    expect(existsSync(join(ROOT, f)), `${f} вернулся: он принимал состав группы и умел слать его наружу`).toBe(false);
  });

  it('MCHS_API_URL и MCHS_API_TOKEN не читает ни код, ни примеры окружения', () => {
    const files = [
      ...['app', 'lib', 'components', 'hooks', 'scripts'].flatMap((d) => walk(d, isCode)),
      ...['.env.example', '.env.local.example', 'start.js', 'Dockerfile'].filter((f) => existsSync(join(ROOT, f))),
      ...walk('.github/workflows', (f) => /\.ya?ml$/.test(f)),
    ];
    expect(files.length).toBeGreaterThan(500);
    const hits = files.filter((f) => /MCHS_API_(URL|TOKEN)/.test(read(f)));
    expect(hits, `адрес приёма заявок МЧС снова упомянут:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('серверный код слоя МЧС не ходит в сеть сам', () => {
  /** Всё, что читает или собирает данные группы для МЧС на сервере. */
  const files = [
    ...walk('lib/safety', (f) => /^mchs-.*\.ts$/.test(f)),
    ...walk('lib/chat-cabinet', (f) => /^mchs-.*\.ts$/.test(f)),
    ...walk('app/api/operator/mchs', isCode),
  ];

  it('перечень не пуст и несёт живые файлы', () => {
    expect(files).toEqual(expect.arrayContaining([
      'lib/safety/mchs-letter.ts', 'lib/safety/mchs-chat.ts', 'lib/chat-cabinet/mchs-store.ts',
      'app/api/operator/mchs/register/route.ts',
    ]));
  });

  // Запрет, а не сравнение текста: этих вызовов в слое быть не должно.
  const OUTBOUND = /\bfetch\s*\(|\baxios\b|\bundici\b|\bXMLHttpRequest\b|\bhttps?\.(request|get)\s*\(|from\s+['"](node:)?https?['"]|\bnet\.connect\b|\bWebSocket\b/;

  it.each(files)('%s — без сетевых вызовов', (f) => {
    const code = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(OUTBOUND);
  });

  it('почту в слое зовёт только письмо на ящик Ведара', () => {
    const mailers = files.filter((f) => /email-service|nodemailer|sendEmail/.test(read(f)));
    expect(mailers).toEqual(['lib/safety/mchs-letter.ts']);
  });
});

describe('живой роут кабинета оператора состав группы никуда не шлёт', () => {
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));

  beforeEach(() => {
    vi.stubEnv('MCHS_API_URL', 'https://example.invalid/register');
    vi.stubEnv('MCHS_API_TOKEN', 'x');
    vi.stubGlobal('fetch', fetchSpy);
    m.query
      .mockResolvedValueOnce({ rows: [{ id: '1042' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'r1', status: 'pending', created_at: '2026-11-10' }] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
    m.query.mockReset();
  });

  it('при заданном MCHS_API_URL сети не трогает, пишет запись кабинета и зовёт подать самому', async () => {
    const res = await POST(new NextRequest('https://vedarai.ru/api/operator/mchs/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bookingId: 1042,
        groupComposition: [{ fullName: 'Тест Тестов', phone: '+70000000000', birthDate: '1990-01-01' }],
        route: 'Авачинский перевал — вершина — перевал',
        startDate: '2027-07-19',
        endDate: '2027-07-20',
        guideContacts: { name: 'Гид Гидов', phone: '+70000000001' },
        emergencyContacts: [{ name: 'Контакт', phone: '+70000000002' }],
      }),
    }));
    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.query).toHaveBeenCalledTimes(2);
    expect(String(m.query.mock.calls[1]![0])).toContain('INSERT INTO mchs_registrations');
    const json = await res.json() as { message: string };
    expect(json.message).toContain('Автоматической отправки в МЧС пока нет');
    expect(json.message).toContain('forms.mchs.gov.ru');
    expect(json.message).not.toMatch(/зарегистрирована|отправлена в МЧС|подана/i);
  });
});
