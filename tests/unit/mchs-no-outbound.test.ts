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
 *  1. удалённые файлы и переменные `MCHS_API_*` не вернулись;
 *  2. запрет: файлы, которые держат в руках состав группы для МЧС (перечень
 *     `FILES` ниже — поимённо, а не «всё с mchs в имени»), сами в сеть не ходят;
 *  3. вызовом: живой роут кабинета оператора при заданном адресе сети не
 *     трогает и говорит подать заявку самому.
 *
 * Чего сторож НЕ видит: сетевой вызов в помощнике из другого каталога, который
 * такой файл позовёт. Этот путь закрыт вызовом там, где группа читается с
 * телефонами: tests/unit/chat-cabinet-service.test.ts жмёт кнопки выезда и
 * письма с подменённым `fetch` и требует, чтобы его не звали.
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

  it('переменных MCHS_API_* не читает ни код, ни примеры окружения', () => {
    const envFiles = ['.env.example', '.env.local.example', '.env.production.example', 'start.js', 'Dockerfile', 'docker-compose.yml'];
    // Примеры окружения — на месте: исчезни они, проверка молча перестала бы их читать.
    expect(envFiles.filter((f) => existsSync(join(ROOT, f)))).toEqual(expect.arrayContaining(['.env.example', '.env.local.example']));
    const files = [
      ...['app', 'lib', 'components', 'hooks', 'scripts'].flatMap((d) => walk(d, isCode)),
      ...envFiles.filter((f) => existsSync(join(ROOT, f))),
      ...walk('.github/workflows', (f) => /\.ya?ml$/.test(f)),
    ];
    expect(files.length).toBeGreaterThan(500);
    // Любое имя с этим началом: до 10.11 в примерах стояли и URL, и TOKEN, и KEY.
    const hits = files.filter((f) => /MCHS_API_/.test(read(f)));
    expect(hits, `адрес приёма заявок МЧС снова упомянут:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('серверный код, который держит состав группы для МЧС, не ходит в сеть сам', () => {
  /**
   * Не к группам: разбор суточной сводки ГУ МЧС (погода, дороги, вулканы).
   * Появится там сетевой вызов — это не утечка состава группы.
   */
  const NOT_ABOUT_GROUPS = new Set(['lib/safety/mchs-bulletin.ts']);

  const FILES = [
    ...walk('lib/safety', (f) => /^mchs-.*\.ts$/.test(f)),
    ...walk('lib/chat-cabinet', (f) => /^mchs-.*\.ts$/.test(f)),
    // Сервис кабинета читает выезд с именами и телефонами (loadMchsGroup с контактами).
    'lib/chat-cabinet/service.ts',
    ...walk('app/api/operator/mchs', isCode),
    // Форма туриста: состав группы и лист «для МЧС».
    ...walk('app/api/safety/register', isCode),
  ].filter((f) => !NOT_ABOUT_GROUPS.has(f));

  it('перечень несёт живые файлы, а исключения существуют', () => {
    expect(FILES).toEqual(expect.arrayContaining([
      'lib/safety/mchs-letter.ts', 'lib/safety/mchs-chat.ts', 'lib/chat-cabinet/mchs-store.ts',
      'lib/chat-cabinet/service.ts', 'app/api/operator/mchs/register/route.ts', 'app/api/safety/register/route.ts',
    ]));
    for (const f of NOT_ABOUT_GROUPS) expect(existsSync(join(ROOT, f)), `${f} — исключение про несуществующий файл`).toBe(true);
  });

  // Запрет, а не сравнение текста: этих вызовов в слое быть не должно.
  const OUTBOUND = /\bfetch\s*\(|\baxios\b|\bundici\b|\bXMLHttpRequest\b|\bhttps?\.(request|get)\s*\(|from\s+['"](node:)?https?['"]|\bnet\.connect\b|\bWebSocket\b/;

  it.each(FILES)('%s — без сетевых вызовов', (f) => {
    const code = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(OUTBOUND);
  });

  it('почту зовёт только письмо на ящик Ведара', () => {
    const mailers = FILES.filter((f) => /email-service|nodemailer|sendEmail/.test(read(f)));
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
