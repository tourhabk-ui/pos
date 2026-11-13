/**
 * lib/mcp/sister-repos.ts — соседние репозитории владельца, которые повторяют
 * сведения из этого, и сверка их с источником.
 *
 * ── Что нашлось 13.11 ──────────────────────────────────────────────────────
 *
 * В этот день описание сервера MCP поменяли и опубликовали версию 2.10.2 — и
 * тот, кто это делал, не знал, что те же сведения записаны ещё в четырёх
 * репозиториях того же владельца. Сверка показала: манифест в `vedar-mcp`
 * стоял на версии 1.0.0 со старым описанием, его README называли 22
 * инструмента из 25, README `vedar-mcp-examples` — 21 из 25, а выложенный
 * плагин `dsh-vedar` отличался от своего исходника здесь в четырёх файлах из
 * семи. Исходник плагина здесь сам отстал: «Tools (23)».
 *
 * Повод посмотреть — статья «The Home Repo Pattern» (слово владельца 13.11
 * «1 да»): агент видит только тот репозиторий, в котором запущен, и о копиях
 * в соседних не узнаёт, пока ему не сказано.
 *
 * ── Почему сверка, а не запись «синхронизировано такого-то» ────────────────
 *
 * Запись о синхронизации — объявление без источника (CLAUDE.md §4): её
 * обновят вместе с версией, а соседний репозиторий — нет. Здесь нет ни одного
 * поля «когда сверяли»: состояние читается из самих репозиториев скриптом
 * `scripts/sister-repos-census.ts` на раннере. Запускает его правка любого
 * источника сведений — см. `.github/workflows/sister-repos-census.yml`.
 *
 * Модуль чистый: файлы ему подаёт вызывающий. Сторож —
 * `tests/unit/sister-repos.test.ts`.
 */

/** Что именно соседний репозиторий повторяет. */
export type SisterCheck =
  /** Файл перечисляет инструменты сервера: назван каждый, число — то же. */
  | { kind: 'tools'; files: readonly string[] }
  /** Манифест сервера: `version` и `description` — как в `server.json` здесь. */
  | { kind: 'manifest'; file: string }
  /** Выложенная копия каталога этого репозитория: файлы равны слово в слово. */
  | { kind: 'mirror'; dir: string; files: readonly string[] };

export interface SisterRepo {
  /** `владелец/имя` на GitHub. */
  repo: string;
  /** Что это — одной фразой, для человека и для агента. */
  what: string;
  checks: readonly SisterCheck[];
}

/**
 * Реестр. Новый свой репозиторий, который повторяет сведения о сервере,
 * вносится сюда — иначе сверка о нём не знает.
 *
 * Копии чужих каталогов (awesome-mcp-servers и подобные) сюда не входят: это
 * ветки для заявок в чужие списки, их состояние ведёт `docs/agents/CATALOGS.md`.
 */
export const SISTER_REPOS: readonly SisterRepo[] = [
  {
    repo: 'tourhabk-ui/vedar-mcp',
    what: 'описание сервера MCP для каталогов, манифест и статьи',
    checks: [
      { kind: 'tools', files: ['README.md', 'README_zh.md'] },
      { kind: 'manifest', file: 'server.json' },
    ],
  },
  {
    repo: 'tourhabk-ui/vedar-mcp-examples',
    what: 'примеры клиентов MCP и таблица инструментов',
    checks: [{ kind: 'tools', files: ['README.md'] }],
  },
  {
    repo: 'tourhabk-ui/vedar-kamchatka-mcp',
    what: 'документация и живые примеры MCP и A2A',
    checks: [{ kind: 'tools', files: ['README.md'] }],
  },
  {
    repo: 'tourhabk-ui/dsh-vedar',
    what: 'плагин DeepSeek Harness; исходник — integrations/dsh-vedar этого репозитория',
    checks: [
      {
        kind: 'mirror',
        dir: 'integrations/dsh-vedar',
        files: ['README.md', 'README.zh.md', 'cordis.patch.yml', 'index.js', 'package.json', 'LICENSE'],
      },
    ],
  },
];

/** Сведения этого репозитория, с которыми сверяют соседние. */
export interface SourceFacts {
  toolNames: readonly string[];
  /** Сколько видов заявок создают пишущие инструменты (`WRITE_TOOL_NAMES`). */
  requestCount: number;
  manifest: { version: string; description: string };
}

/**
 * Три исхода (§4.0): совпало; отстал; не смог прочитать. Третий не равен
 * первому: несклонированный репозиторий — не «всё в порядке».
 */
export type SisterStatus = 'ok' | 'behind' | 'unreadable';

export interface SisterFinding {
  repo: string;
  file: string;
  status: SisterStatus;
  /** Что именно не так — словами; у `ok` пусто. */
  details: string[];
}

/** Имена инструментов, которых текст не называет. Имя считается названным в обратных кавычках. */
export function toolsMissingIn(text: string, toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => !text.includes('`' + name + '`'));
}

/**
 * Числа, которыми текст называет количество инструментов: «21 tools»,
 * «Tools (23)», «22 个工具», «工具（20 个）», «25 инструментов».
 *
 * Число через слово («17 Vedar tools» — сколько вызовов сделала проба) сюда
 * не попадает намеренно: это не утверждение о составе сервера.
 */
export function toolCountClaims(text: string): number[] {
  const found: number[] = [];
  const patterns = [
    /(\d+)\s+tools\b/gi,
    /\btools\s*\((\d+)\)/gi,
    /(\d+)\s*个工具/g,
    /工具\s*[（(]\s*(\d+)\s*个?\s*[）)]/g,
    /(\d+)\s+инструмент/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.push(Number(m[1]));
  }
  return found;
}

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8,
  '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8,
};

/**
 * Числа, которыми текст называет количество видов заявок: «five requests»,
 * «six request types», «Four write tools», «четыре заявки», «Заявок шесть»,
 * «四种申请».
 *
 * Только числа словами: цифра перед «requests» в таких текстах — это предел
 * частоты («5 requests per hour»), а не состав сервера.
 */
export function requestCountClaims(text: string): number[] {
  const found: number[] = [];
  const patterns = [
    /\b(two|three|four|five|six|seven|eight)\s+(?:write\s+tools|request\s+types|requests)\b/gi,
    /(?<![а-яё])(два|две|три|четыре|пять|шесть|семь|восемь)\s+заяв/gi,
    /заявок\s+(два|две|три|четыре|пять|шесть|семь|восемь)(?![а-яё])/gi,
    /([二两三四五六七八])\s*种申请/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = WORD_NUMBERS[m[1].toLowerCase()];
      if (n !== undefined) found.push(n);
    }
  }
  return found;
}

/** Какое число видов заявок текст называет не то; пусто — расхождений нет. */
export function requestCountLag(text: string, requestCount: number): string[] {
  const wrong = [...new Set(requestCountClaims(text).filter((n) => n !== requestCount))];
  return wrong.length ? [`названо число видов заявок ${wrong.join(', ')}, у сервера их ${requestCount}`] : [];
}

/** Сверка одного текста с составом сервера: чего нет и какое число названо не то. */
export function toolsLag(text: string, facts: Pick<SourceFacts, 'toolNames' | 'requestCount'>): string[] {
  const details: string[] = [];
  const missing = toolsMissingIn(text, facts.toolNames);
  if (missing.length) details.push(`не названы инструменты: ${missing.join(', ')}`);
  const wrong = [...new Set(toolCountClaims(text).filter((n) => n !== facts.toolNames.length))];
  if (wrong.length) details.push(`названо число инструментов ${wrong.join(', ')}, у сервера их ${facts.toolNames.length}`);
  details.push(...requestCountLag(text, facts.requestCount));
  return details;
}

/** Сверка манифеста: `null` — текст не разобрался как JSON. */
export function manifestLag(text: string, manifest: SourceFacts['manifest']): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const doc = parsed as Record<string, unknown>;
  const details: string[] = [];
  if (doc.version !== manifest.version) {
    details.push(`версия ${typeof doc.version === 'string' ? doc.version : 'не записана'}, здесь ${manifest.version}`);
  }
  if (doc.description !== manifest.description) details.push('описание не то, что в server.json здесь');
  return details;
}

/** Конец строки и хвостовые пробелы — не расхождение. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  return norm(a) === norm(b);
}

/** Читатель файла: `null` — файла нет или он не прочитался. */
export type FileReader = (path: string) => string | null;

/**
 * Сверить один соседний репозиторий.
 *
 * @param available склонирован ли репозиторий; `false` — одна находка «не смог»
 * @param readSister читает файл соседнего репозитория по пути от его корня
 * @param readOwn    читает файл этого репозитория по пути от его корня
 */
export function checkSister(
  sister: SisterRepo,
  facts: SourceFacts,
  available: boolean,
  readSister: FileReader,
  readOwn: FileReader,
): SisterFinding[] {
  if (!available) {
    return [{ repo: sister.repo, file: '—', status: 'unreadable', details: ['репозиторий не прочитан'] }];
  }
  const out: SisterFinding[] = [];
  const push = (file: string, details: string[] | null, unreadable = 'файл не прочитан') => {
    if (details === null) out.push({ repo: sister.repo, file, status: 'unreadable', details: [unreadable] });
    else out.push({ repo: sister.repo, file, status: details.length ? 'behind' : 'ok', details });
  };
  for (const check of sister.checks) {
    if (check.kind === 'tools') {
      for (const file of check.files) {
        const text = readSister(file);
        push(file, text === null ? null : toolsLag(text, facts), 'файла нет в репозитории');
      }
    } else if (check.kind === 'manifest') {
      const text = readSister(check.file);
      if (text === null) push(check.file, null, 'файла нет в репозитории');
      else push(check.file, manifestLag(text, facts.manifest), 'манифест не разобрался как JSON');
    } else {
      for (const file of check.files) {
        const own = readOwn(`${check.dir}/${file}`);
        if (own === null) {
          push(file, null, `исходника ${check.dir}/${file} здесь нет`);
          continue;
        }
        const theirs = readSister(file);
        if (theirs === null) push(file, ['файла нет в выложенном репозитории']);
        else push(file, sameText(own, theirs) ? [] : [`отличается от ${check.dir}/${file}`]);
      }
    }
  }
  return out;
}

/** Итог сверки: отставание главнее непрочитанного — оно уже факт. */
export function censusOutcome(findings: readonly SisterFinding[]): SisterStatus {
  if (findings.some((f) => f.status === 'behind')) return 'behind';
  if (findings.some((f) => f.status === 'unreadable')) return 'unreadable';
  return 'ok';
}

const STATUS_WORD: Record<SisterStatus, string> = {
  ok: 'совпадает',
  behind: 'отстал',
  unreadable: 'не смог прочитать',
};

/** Таблица для сводки прогона. */
export function censusTable(findings: readonly SisterFinding[]): string {
  const lines = ['| Репозиторий | Файл | Исход | Что не так |', '|---|---|---|---|'];
  for (const f of findings) {
    lines.push(`| ${f.repo} | ${f.file} | ${STATUS_WORD[f.status]} | ${f.details.join('; ') || '—'} |`);
  }
  return lines.join('\n');
}

/** Одна строка итога — её читает человек в заголовке прогона. */
export function censusVerdict(findings: readonly SisterFinding[]): string {
  const behind = [...new Set(findings.filter((f) => f.status === 'behind').map((f) => f.repo))];
  const unread = [...new Set(findings.filter((f) => f.status === 'unreadable').map((f) => f.repo))];
  const parts: string[] = [];
  if (behind.length) parts.push(`отстали: ${behind.join(', ')}`);
  if (unread.length) parts.push(`не прочитаны: ${unread.join(', ')}`);
  return parts.length ? parts.join('; ') : 'соседние репозитории совпадают с этим';
}
