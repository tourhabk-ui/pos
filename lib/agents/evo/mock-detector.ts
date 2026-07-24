/**
 * Детектор фейка/моков/заглушек — новый объектив Growth Scan. Ловит класс
 * проблем «витрина-обманка», к которому код-безопасность слепа: захардкоженные
 * мок-данные вместо реальных, экраны, притворяющиеся живыми. Для платформы,
 * которая обещает «не врать», это прямая дыра доверия (пример — мок-«Заявки»
 * transfer-operator: выдуманные брони + кнопки-пустышки).
 *
 * Детерминированный, точечный (низкий ложняк — находки идут в Issues, которые
 * потом реализует Claude Code; ложные срабатывания дороги). Чистая функция —
 * под тестом.
 */
import type { GrowthIssue } from '@/lib/agents/evo/growth-agent';

/** Массив-литерал из ≥2 объектов со строковыми полями — похоже на захардкоженные данные. */
const HARDCODED_DATA_ARRAY = /=\s*\[\s*\{[\s\S]{0,400}?\}\s*,\s*\{/;
/** Одиночный объект в setState-моке тоже считается (напр. один фейковый маршрут). */
const HARDCODED_SINGLE = /set[A-Z]\w*\(\s*\[\s*\{[\s\S]{0,200}?['"][\s\S]{0,200}?\}\s*\]\s*\)/;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/**
 * Находит мок/фейк-паттерны в исходнике. Работает по клиент-компонентам (.tsx)
 * и роутам. Возвращает находки формата GrowthIssue (категория ux/dead_code).
 */
export function detectMockPatterns(filePath: string, content: string): GrowthIssue[] {
  const issues: GrowthIssue[] = [];
  // Тесты/сторибуки/сиды — мок там легитимен.
  if (/\.test\.|__tests__|\.stories\.|\/seed|mock-data-allowed/.test(filePath)) return issues;

  const isClient = content.includes("'use client'") || content.includes('"use client"');
  const hasFetch = /\bfetch\s*\(|useSWR|useQuery\(|\baxios\b/.test(content);
  const hasTimeoutData = /setTimeout\s*\(/.test(content) && (HARDCODED_DATA_ARRAY.test(content) || HARDCODED_SINGLE.test(content));

  // 1) Экран-обманка: клиент-компонент грузит захардкоженные данные через
  //    setTimeout и НЕ ходит в API. Классическая фейк-витрина.
  if (isClient && hasTimeoutData && !hasFetch) {
    const m = content.match(/setTimeout\s*\(/);
    issues.push({
      category: 'ux',
      severity: 'high',
      file_path: filePath,
      line_number: m ? lineOf(content, m.index ?? 0) : undefined,
      title: 'Экран на мок-данных',
      description: 'Клиент-компонент показывает захардкоженные данные через setTimeout и не обращается к API — витрина-обманка, пользователь видит выдуманное как реальное.',
      suggestion: 'Подключить экран к реальному API (fetch к соответствующему /api/... эндпоинту) или, если данных нет, честное пустое состояние вместо фейка.',
    });
  }

  // 2) Кнопка-пустышка: есть действие подтвердить/отменить/принять, но файл не
  //    делает ни одной мутации (fetch/POST) — кнопка меняет только локальный стейт.
  const hasActionWords = /(подтверд|отклон|отмен|принять|одобр|approve|confirm|reject|accept)/i.test(content);
  const hasMutation = /fetch\s*\([^)]*\{[\s\S]{0,120}?method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(content)
    || /method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(content);
  if (isClient && hasActionWords && /onClick=/.test(content) && !hasFetch && !hasMutation) {
    issues.push({
      category: 'ux',
      severity: 'medium',
      file_path: filePath,
      title: 'Кнопки действий без мутации',
      description: 'Есть кнопки подтвердить/отменить/принять, но компонент не делает ни одного мутирующего запроса — действия, вероятно, ничего не меняют в БД (кнопки-пустышки).',
      suggestion: 'Привязать обработчики к реальным API-мутациям (POST/PATCH) либо убрать вводящие в заблуждение кнопки.',
    });
  }

  // 3) Явные маркеры-заглушки в проде (не в комментах-TODO общего вида).
  const stub = content.match(/placeholder\.com|example\.com\/(?!\s)|\bзаглушк|\bMOCK_[A-Z]|const\s+mockData\b/);
  if (stub) {
    issues.push({
      category: 'tech_debt',
      severity: 'low',
      file_path: filePath,
      line_number: lineOf(content, stub.index ?? 0),
      title: 'Маркер-заглушка в коде',
      description: `Найден признак заглушки/мока (${stub[0]}) в продакшн-файле.`,
      suggestion: 'Заменить на реальные данные/источник или удалить, если не используется.',
    });
  }

  return issues;
}
