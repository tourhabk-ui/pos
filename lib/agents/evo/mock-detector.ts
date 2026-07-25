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

/**
 * Имитация загрузки: setTimeout, ВНУТРИ которого стейт заполняется литералом
 * объекта/массива. Раньше признаком считался любой setTimeout рядом с
 * захардкоженным массивом — и детектор клеймил экраны с таймером кнопки
 * «скопировано» (`setTimeout(() => setCopied(false), 2000)`) плюс статическим
 * конфигом. Аудит админки 24.07: 3 находки из 3 оказались ложными.
 */
const FAKE_LOAD = /setTimeout\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{?[\s\S]{0,200}?set[A-Z]\w*\s*\(\s*\[?\s*\{/;

/**
 * Кнопка сохранения, которая ничего не сохраняет: обработчик крутит спиннер
 * через setTimeout и на этом всё. Аудит 25.07: форма «Профиль гида» полгода
 * показывала выдуманного «Ивана Петрова» и кнопку «Сохранить», не трогающую БД,
 * при живом и защищённом /api/guide/profile.
 */
const FAKE_SAVE = /set(?:Saving|Loading|Submitting|Sending)\s*\(\s*true\s*\)[\s\S]{0,300}?setTimeout\s*\(\s*\(\s*\)\s*=>\s*set(?:Saving|Loading|Submitting|Sending)\s*\(\s*false/;

/**
 * Компонент принимает типизированные пропсы — данные приходят из СЕРВЕРНОГО
 * компонента (канонический паттерн App Router: page.tsx делает SQL и передаёт
 * результат в клиент). Отсутствие fetch у такого экрана — норма, а не фейк.
 */
const RECEIVES_SERVER_PROPS = /\}\s*:\s*\{[^{}]*\}\s*\)\s*\{/;

/** Кнопки, которые НЕ должны мутировать БД по своей природе. */
const NON_MUTATING_UI = /navigator\.clipboard|router\.(push|replace|back)|window\.open|scrollTo|setOpen|setExpanded|setCopied/;

/** JSX-атрибут placeholder — подсказка в поле ввода, а не заглушка в данных. */
function stripPlaceholderAttrs(src: string): string {
  return src.replace(/placeholder\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g, 'placeholder=""');
}

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
  // Данные могут приходить пропсами из серверного компонента — это не фейк.
  const serverProps = RECEIVES_SERVER_PROPS.test(content);
  // FAKE_LOAD сам по себе — уже полная подпись имитации: setTimeout, внутри
  // которого стейт заполняется литералом объекта. Прежде дополнительно
  // требовался ОТДЕЛЬНЫЙ короткий литерал (HARDCODED_*), и мок тем вернее
  // ускользал, чем он крупнее: «Профиль гида» (один объект в форме) и «Отзывы
  // гида» (три длинных объекта) не ловились ни разу. Обратный путь — считать
  // признаком любой литерал-массив рядом с useState — даёт ложняки на статике
  // (шаги онбординга, колонки таблицы), проверено на 262 экранах кабинетов.
  const hasTimeoutData = FAKE_LOAD.test(content);

  // 1) Экран-обманка: клиент-компонент ИМИТИРУЕТ загрузку (setTimeout →
  //    setState литералом), не ходит в API и не получает данные пропсами.
  if (isClient && hasTimeoutData && !hasFetch && !serverProps) {
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
  // Кнопки копирования/навигации/раскрытия мутаций не делают по замыслу, а
  // экран на серверных пропсах может мутировать через server action.
  const onlyUiButtons = NON_MUTATING_UI.test(content);
  if (isClient && hasActionWords && /onClick=/.test(content)
      && !hasFetch && !hasMutation && !onlyUiButtons && !serverProps) {
    issues.push({
      category: 'ux',
      severity: 'medium',
      file_path: filePath,
      title: 'Кнопки действий без мутации',
      description: 'Есть кнопки подтвердить/отменить/принять, но компонент не делает ни одного мутирующего запроса — действия, вероятно, ничего не меняют в БД (кнопки-пустышки).',
      suggestion: 'Привязать обработчики к реальным API-мутациям (POST/PATCH) либо убрать вводящие в заблуждение кнопки.',
    });
  }

  // 2b) Форма «сохраняет» таймером: спиннер включается и гасится setTimeout,
  //     мутации нет. Отдельный признак — слово «сохранить» слишком частое,
  //     чтобы ловить по нему, а вот эта связка однозначна.
  if (isClient && FAKE_SAVE.test(content) && !hasMutation) {
    const m = content.match(FAKE_SAVE);
    issues.push({
      category: 'ux',
      severity: 'high',
      file_path: filePath,
      line_number: m ? lineOf(content, m.index ?? 0) : undefined,
      title: 'Форма сохраняет в никуда',
      description: 'Обработчик сохранения только переключает спиннер через setTimeout и не делает ни одного мутирующего запроса — пользователь считает данные сохранёнными, а их нет.',
      suggestion: 'Отправлять данные в соответствующий /api/... (PUT/PATCH) и показывать реальный результат либо убрать форму.',
    });
  }

  // 3) Явные маркеры-заглушки в проде (не в комментах-TODO общего вида).
  // placeholder="https://example.com/rss.xml" — подсказка в поле ввода, не мок.
  const stub = stripPlaceholderAttrs(content)
    .match(/placeholder\.com|example\.com\/(?!\s)|\bзаглушк|\bMOCK_[A-Z]|const\s+mockData\b/);
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
