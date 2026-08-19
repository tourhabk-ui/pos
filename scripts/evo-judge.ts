/**
 * scripts/evo-judge.ts
 *
 * Разбор находок эволюции сильной моделью — НА РАННЕРЕ GitHub.
 *
 * ── Зачем именно на раннере ────────────────────────────────────────────────
 *
 * Решатель эволюции переведён на DeepSeek с Qwen на подхвате не потому, что
 * они лучше, а потому что api.anthropic.com закрыт по гео из России, где
 * стоит прод. Наши кроны — это `curl` с раннера в прод, то есть модель зовёт
 * сервер в РФ, и ключ Anthropic в секретах GitHub делу бы не помог.
 *
 * Здесь работа делается ровно наоборот: находки СКАЧИВАЮТСЯ с прода, а модель
 * зовётся с раннера — он вне РФ, гео-блока нет, релей не нужен.
 *
 * ── Чего этот скрипт НЕ делает ─────────────────────────────────────────────
 *
 * Он ничего не чинит и ничего не пишет в базу. Он только судит и объясняет.
 * Финальное решение по находке остаётся за человеком и за Claude Code в репо —
 * это записано в CLAUDE.md и менять здесь нечего.
 *
 * ── Тишина не считается ответом ────────────────────────────────────────────
 *
 * Нет ключа — падаем с внятной ошибкой, а не выдаём пустой разбор. Модель не
 * ответила по находке — она помечается «не разобрана», а не «шум». Пустой
 * результат, выданный за чистый, — дефект, который мы весь день ловим; в
 * инструменте разбора он был бы особенно дорог.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { callAIDecisionDetailed } from '@/lib/ai/providers';
import { redactPII } from '@/lib/security/pii-redact';
import type { ChatMessage } from '@/lib/ai/prompts';

interface Finding {
  id: string;
  category: string;
  severity: string;
  file_path: string | null;
  line_number: number | null;
  title: string;
  description: string | null;
  suggestion: string | null;
}

export type Verdict = 'real' | 'noise' | 'needs_info' | 'unjudged';

export interface Judged {
  finding: Finding;
  verdict: Verdict;
  reason: string;
  /** Какая модель вынесла вердикт — атрибуция, как у находок Growth Scan. */
  model?: string;
}

const VERDICT_RU: Record<Verdict, string> = {
  real: 'по делу',
  noise: 'шум',
  needs_info: 'мало данных',
  unjudged: 'не разобрана',
};

const SYSTEM = `Ты разбираешь находки автоматического сканера кода туристической платформы.

Твоя задача — отделить настоящие дефекты от шума сканера, а не пересказать находку.

Отвечай РОВНО в таком виде, одной строкой:
ВЕРДИКТ: real|noise|needs_info
ПРИЧИНА: одно предложение, не длиннее двадцати слов

real — дефект настоящий, его стоит чинить.
noise — сканер ошибся: санкционированная конструкция, ложное совпадение, «X вместо X».
needs_info — по тексту находки решить нельзя, нужен код вокруг.

Не выдумывай подробностей, которых нет в находке. Если сомневаешься — needs_info.`;

/** Один разбор. Провал — это `unjudged`, а не «шум». */
export async function judgeOne(f: Finding): Promise<Judged> {
  // ПД перед отправкой во внешнюю модель чистятся всегда: находка может
  // процитировать строку кода с телефоном или почтой (152-ФЗ, см.
  // lib/agents/compliance). Дешевле почистить, чем доказывать, что не было.
  const body = redactPII([
    `Категория: ${f.category}`,
    `Важность: ${f.severity}`,
    f.file_path ? `Файл: ${f.file_path}${f.line_number ? `:${f.line_number}` : ''}` : null,
    `Заголовок: ${f.title}`,
    f.description ? `Описание: ${f.description}` : null,
    f.suggestion ? `Предложение сканера: ${f.suggestion}` : null,
  ].filter(Boolean).join('\n'));

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: body },
  ];

  // Водопад решателя, а не голый callAnthropic. Три дня подряд (12-14.08)
  // отчёты выходили с «не разобрано: 30+ — модель не ответила»: Anthropic
  // отдавал пустой ответ, и на этом разбор заканчивался, хотя DeepSeek и
  // Qwen — штатный запасной путь решателя (CLAUDE.md §8: «для сильного
  // решателя достаточно DeepSeek/Qwen без релея»). Водопад пробует флагмана,
  // Anthropic напрямую, затем DeepSeek и Qwen — и штампует, кто ответил.
  const res = await callAIDecisionDetailed(messages);
  const answer = res.text;
  if (!answer) {
    // ПОЧЕМУ никто не ответил — водопад это знает и кладёт в `error` по
    // ступеням. Раньше поле выбрасывалось, и отчёт говорил «модель не
    // ответила» одинаково при отсутствующем ключе, гео-блоке, исчерпанной
    // квоте и таймауте. Разбор 18.08 вышел 41 из 41 неразобранным, среди них
    // была critical-инъекция, и восемь суток никто не знал, что чинить.
    return {
      finding: f,
      verdict: 'unjudged',
      reason: res.error ? `модель не ответила: ${res.error}`.slice(0, 300) : 'модель не ответила',
    };
  }

  const v = /ВЕРДИКТ:\s*(real|noise|needs_info)/i.exec(answer);
  const r = /ПРИЧИНА:\s*(.+)/i.exec(answer);
  if (!v) {
    // Ответ есть, но формы нет — это тоже «не разобрана». Догадываться о
    // вердикте по свободному тексту значит снова выдать неуверенность за вывод.
    return { finding: f, verdict: 'unjudged', reason: 'ответ не в заданной форме', model: res.model };
  }
  return {
    finding: f,
    verdict: v[1].toLowerCase() as Verdict,
    reason: (r?.[1] ?? '').trim().slice(0, 200) || 'причина не названа',
    model: res.model,
  };
}

/** Отчёт для GitHub Issue. Числа сверху, подробности ниже. */
export function renderReport(judged: Judged[]): string {
  const by = (v: Verdict) => judged.filter((j) => j.verdict === v);
  const real = by('real'), noise = by('noise'), info = by('needs_info'), un = by('unjudged');

  const lines: string[] = [];
  lines.push(`Разобрано находок: **${judged.length}**`);
  // Атрибуция: по прошлым отчётам нельзя было отличить «Anthropic молчит»
  // от «ключа нет» — модель судьи теперь названа в отчёте фактом.
  const models = [...new Set(judged.map((j) => j.model).filter(Boolean))] as string[];
  if (models.length > 0) lines.push(`Судья: ${models.join(', ')}`);
  lines.push('');
  lines.push('| Вердикт | Сколько |');
  lines.push('|---|---|');
  lines.push(`| по делу | ${real.length} |`);
  lines.push(`| шум | ${noise.length} |`);
  lines.push(`| мало данных | ${info.length} |`);
  lines.push(`| не разобрана | ${un.length} |`);
  lines.push('');

  if (un.length > 0) {
    // Названо отдельно и до подробностей: неразобранное легко принять за
    // «ничего не нашли», а это разные вещи.
    lines.push(`> Не разобрано: ${un.length}. Это не «чисто» — это отсутствие ответа.`);
    lines.push('');
    // Причины — списком РАЗЛИЧНЫХ, а не по разу на находку: сорок одинаковых
    // строк «модель не ответила: deepseek: ключа нет» прячут ответ, ради
    // которого их печатают.
    const reasons = [...new Set(un.map((j) => j.reason))];
    if (reasons.length > 0 && un.length === judged.length) {
      lines.push('Разобрать не удалось НИ ОДНОЙ находки. Причины по ступеням решателя:');
      for (const r of reasons.slice(0, 5)) lines.push(`- ${r}`);
      lines.push('');
    }
  }

  for (const [title, group] of [
    ['По делу', real], ['Мало данных', info], ['Шум', noise], ['Не разобрано', un],
  ] as Array<[string, Judged[]]>) {
    if (group.length === 0) continue;
    lines.push(`## ${title}`);
    for (const j of group) {
      const where = j.finding.file_path
        ? ` — \`${j.finding.file_path}${j.finding.line_number ? `:${j.finding.line_number}` : ''}\``
        : '';
      lines.push(`- **${j.finding.title}**${where}`);
      lines.push(`  ${VERDICT_RU[j.verdict]}: ${j.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    throw new Error('Использование: evo-judge.ts <находки.json> <отчёт.md>');
  }
  // Отсутствие ВСЕХ ключей — это отказ, а не пустой разбор. Водопаду решателя
  // хватает ЛЮБОГО из путей, и OpenRouter в этом списке первый по порядку
  // вызова — но до 19.08 его тут не было. Значит, заведя только его, владелец
  // получил бы отказ «нет ни одного ключа» при живом ключе: проверка знала не
  // те имена, что зовёт водопад.
  const KEYS = ['OPENROUTER_API_KEY', 'OR_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'];
  if (!KEYS.some((k) => process.env[k])) {
    throw new Error(`Нет ни одного ключа модели (${KEYS.join('/')}): разбирать нечем. Пустой отчёт был бы враньём.`);
  }

  const raw = JSON.parse(readFileSync(inPath, 'utf-8')) as { issues?: Finding[] };
  const findings = Array.isArray(raw.issues) ? raw.issues : [];
  if (findings.length === 0) {
    writeFileSync(outPath, 'Открытых находок нет.\n');
    return;
  }

  const judged: Judged[] = [];
  for (const f of findings.slice(0, 40)) {
    judged.push(await judgeOne(f));
  }
  if (findings.length > 40) {
    // Потолок назван вслух: молчаливая обрезка читается как «разобрали всё».
    judged.push({
      finding: { id: '', category: '', severity: '', file_path: null, line_number: null,
        title: `Ещё ${findings.length - 40} находок не разбирались (потолок прогона)`,
        description: null, suggestion: null },
      verdict: 'unjudged', reason: 'за потолком в 40 находок',
    });
  }

  writeFileSync(outPath, renderReport(judged));
}

// Запуск только как скрипт: при импорте из теста main не вызывается.
if (process.argv[1] && process.argv[1].endsWith('evo-judge.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
