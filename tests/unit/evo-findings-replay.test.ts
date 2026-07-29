/**
 * Регрессия на настоящих ложных находках: прогон текстов реальных issue через
 * стража с реальным телом файла.
 *
 * 24–25.07.2026 Growth Scan завёл пятнадцать critical-issues (#757–#776), почти
 * все — про `app/api/hub/bookings/create/route.ts`. 28.07 каждое утверждение
 * сверено с файлом:
 *   - «нет requireAuth» (десять раз) — авторизация в роуте опциональна ПО
 *     ЗАМЫСЛУ, гостевой чек-аут, и это написано комментарием в коде;
 *   - «нет try/catch» — try/catch стоит;
 *   - «race condition, нужен FOR UPDATE» — FOR UPDATE стоит;
 *   - «SQL-инъекция», с цитатой кода — конкатенации в файле нет ни одной,
 *     весь SQL параметризован через $1. Процитированные строки выдуманы.
 * Плюс #776 по `lib/kuzmich/core.ts`: «запрос без параметризации:
 * WHERE telegram_chat_id = $1» — `$1` и есть параметризация.
 *
 * Тексты ниже — из тел этих issue. Файлы читаются с диска, не из фикстуры:
 * если кто-то однажды уберёт из роута FOR UPDATE или параметризацию, тест
 * упадёт и скажет об этом — что тоже полезно.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isCredibleFinding, verifyAgainstSource } from '@/lib/agents/evo/finding-guard';

const ROOT = process.cwd();
const BOOKING_SRC = readFileSync(join(ROOT, 'app/api/hub/bookings/create/route.ts'), 'utf-8');
const KUZMICH_SRC = readFileSync(join(ROOT, 'lib/kuzmich/core.ts'), 'utf-8');

interface Case {
  issue: string;
  title: string;
  description: string;
  suggestion: string;
  source: string;
}

const FALSE_FINDINGS: Case[] = [
  {
    issue: '#757',
    title: 'Потенциальная race condition при создании бронирования',
    description: 'Если несколько запросов одновременно пытаются забронировать последнее место на тур, возможна ситуация двойного бронирования из-за отсутствия блокировки или транзакционной изоляции.',
    suggestion: 'Добавить пессимистичную блокировку строки: SELECT ... FOR UPDATE',
    source: BOOKING_SRC,
  },
  {
    issue: '#758',
    title: 'Отсутствует try/catch для обработки ошибок',
    description: 'Вызов bookingService.createBooking() не обёрнут в try/catch. Любая ошибка приведёт к необработанному исключению и 500 без логирования.',
    suggestion: 'Добавьте блок try/catch вокруг вызова',
    source: BOOKING_SRC,
  },
  {
    issue: '#760',
    title: 'Отсутствует requireAuth для защищённого route',
    description: "Строка 42: обработчик POST не вызывает requireAuth() или requireRole('operator').",
    suggestion: 'Добавить вызов requireAuth() перед логикой создания брони',
    source: BOOKING_SRC,
  },
  {
    issue: '#764',
    title: 'Отсутствует requireAuth на маршруте',
    description: 'Роут создания бронирования не проверяет JWT-токен. Любой неавторизованный пользователь может создать бронь.',
    suggestion: 'Добавить вызов requireAuth в начале обработчика',
    source: BOOKING_SRC,
  },
  {
    issue: '#768',
    title: 'SQL-инъекция в запросе',
    description: "Строка 42: конкатенация 'SELECT * FROM bookings WHERE id = ' + bookingId вместо параметризованного запроса.",
    suggestion: 'Заменить конкатенацию на параметризованный запрос с плейсхолдером',
    source: BOOKING_SRC,
  },
  {
    issue: '#770',
    title: 'SQL-инъекция в запросе бронирования',
    description: "Строка 45: конкатенация WHERE id = '${tourId}' вместо параметризованного запроса.",
    suggestion: 'Заменить строку с конкатенацией на параметризованный запрос',
    source: BOOKING_SRC,
  },
  {
    issue: '#772',
    title: 'SQL-инъекция в $1',
    description: "Строка 45: query = 'INSERT INTO operator_bookings (...) VALUES (...)' + userId — конкатенация userId в SQL без параметризации.",
    suggestion: 'Заменить конкатенацию на параметризованный запрос',
    source: BOOKING_SRC,
  },
  {
    issue: '#774',
    title: 'SQL-инъекция в бронировании',
    description: 'Строка 45: WHERE id = ${id} вместо параметризованного запроса.',
    suggestion: 'Заменить строку на параметризованный запрос',
    source: BOOKING_SRC,
  },
  {
    issue: '#776',
    title: 'SQL-инъекция в pool.query',
    description: 'В функции loadUserSituation() SQL-запрос к таблице leads использует параметр напрямую в строке запроса без параметризации: WHERE telegram_chat_id = $1.',
    suggestion: 'Заменить строку запроса на параметризованный вариант',
    source: KUZMICH_SRC,
  },
];

function rejectionFor(c: Case): string | null {
  const f = { title: c.title, description: c.description, suggestion: c.suggestion };
  if (!isCredibleFinding(f)) return 'content_free_guard';
  return verifyAgainstSource(f, c.source);
}

describe('ложные находки Growth Scan не проходят стража', () => {
  for (const c of FALSE_FINDINGS) {
    it(`${c.issue} — ${c.title}`, () => {
      const reason = rejectionFor(c);
      expect(reason, 'находка снова прошла бы наружу как critical-issue').not.toBeNull();
    });
  }

  it('файл бронирования всё ещё защищён так, как утверждает этот тест', () => {
    // Тест держится на свойствах реального файла. Если их не станет, находки
    // выше перестанут быть ложными — и об этом надо узнать здесь, а не из
    // молчаливо прошедшего issue.
    expect(BOOKING_SRC, 'пропала блокировка').toMatch(/FOR\s+UPDATE/i);
    expect(BOOKING_SRC, 'пропал try/catch').toMatch(/\btry\s*\{/);
    expect(BOOKING_SRC, 'пропала проверка токена').toMatch(/verifyToken|extractToken/);
  });
});

describe('настоящие находки страж пропускает', () => {
  it('инъекция в файле, где склейка действительно есть', () => {
    const vulnerable = 'const sql = `SELECT * FROM leads WHERE id = ${id}`;\nawait pool.query(sql);';
    expect(rejectionFor({
      issue: 'синтетика', title: 'SQL-инъекция',
      description: 'Конкатенация значения в SQL вместо параметризации',
      suggestion: 'Использовать $1', source: vulnerable,
    })).toBeNull();
  });

  it('отсутствие try/catch в файле, где его действительно нет', () => {
    const bare = 'export async function POST(req){ const b = await req.json(); return doThing(b); }';
    expect(rejectionFor({
      issue: 'синтетика', title: 'Нет обработки ошибок',
      description: 'Внешний вызов не обёрнут в try/catch',
      suggestion: 'Добавить try/catch', source: bare,
    })).toBeNull();
  });
});
