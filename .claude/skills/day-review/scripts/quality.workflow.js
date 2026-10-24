export const meta = {
  name: 'day-review-quality',
  description: 'Проверка качества влитого за окно: искатель на тему и опровергатель его находок; без правок',
  phases: [{ title: 'Поиск' }, { title: 'Опровержение' }],
}

// args: { window: { from, to }, scratch: '<каталог scratchpad>', groups: [{ key, title, prs }] }
// — см. references/workflow-args.md
const W = args.window
const S = args.scratch
const BASE = `Репозиторий: /home/user/pos (платформа Ведар; правила — CLAUDE.md у тебя в контексте). Проверяется КАЧЕСТВО кода, влитого в main с ${W.from} до ${W.to} UTC.
ЖЁСТКО: ничего не исправляй. В /home/user/pos ничего не меняй и не делай checkout/reset/stash — там работают другие. Не пиши на GitHub. Код текущего main читай через git -C /home/user/pos show origin/main:<путь>. Мутации тестов — только в своей копии: git -C /home/user/pos worktree add ${S}/qa-KEY origin/main && ln -s /home/user/pos/node_modules ${S}/qa-KEY/node_modules; мутируй и запускай npx vitest run <файл> там; в конце git -C /home/user/pos worktree remove --force ${S}/qa-KEY. PostgreSQL для *.pg.test.ts: KERNEL_PG_TEST_URL=postgresql://postgres@127.0.0.1:55432/postgres.
Диффы: git -C /home/user/pos show <sha>. Тело PR: mcp__github__pull_request_read (owner tourhabk-ui, repo pos) или curl -sS https://api.github.com/repos/tourhabk-ui/pos/pulls/<N>.
Только настоящие дефекты с конкретным сценарием «вход/состояние → неверный исход», file:line на origin/main. Не стиль.`

const LENSES = `Три стороны:
1) Ошибки: логика, SQL против схемы (типы, 42P08 в INSERT…SELECT WHERE NOT EXISTS, timestamp с/без зоны, NULL), гонки (двойное нажатие, повтор апдейта мессенджера), отказ базы, сломанные прежние сценарии.
2) Правила: ПД туриста не уходят в Telegram, модель, лог, историю чата (свободный текст партнёра с телефоном туриста идёт в модель через processPartnerMessage, lib/kuzmich/operator-chat.ts, — есть ли redactPII; проверь вызовом); действие в MAX — только по заверенному апдейту и праву нажавшего; requireAuth/requireAdmin; честность §0 и §4.0 (нет выдуманных чисел, отказ базы ≠ «нет данных», нет пустых catch); миграции идемпотентны, номер max+1; зоны §7 (scripts/protected-zones.mjs) — есть ли «Слово владельца».
3) Тесты: проверяют поведение, а не текст исходника; поймали бы откат главной правки — для 1–2 ключевых правок темы проверь мутацией в своей копии и назови каждую мутацию с итогом — «держит» только про сделанные, остальное «не проверено мутацией»; прогони тесты PR и скажи итог (сколько тестовых файлов в PR — по git show <sha> --stat, а не по тому, что прогнал).
Два приёма, которые находят невидимое чтением: (а) тесты со сроком или зашитой датой (TTL ссылки, пауза до даты) прогони с vi.setSystemTime на неделю вперёд; (б) если PR трогает чаты — прогони «помогите, мы заблудились» через вебхук MAX и Telegram в своей копии до PR и после и сравни, есть ли 112. У Telegram живой вход — /api/telegram/webhook; /api/telegram/kuzmich к боту не подключён.`

const FINDINGS = {
  type: 'object',
  properties: {
    tests_run: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: {
      pr: { type: 'number' }, title: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' },
      severity: { type: 'string', enum: ['blocking', 'should-fix', 'minor'] },
      lens: { type: 'string', enum: ['ошибка', 'правила', 'тесты'] },
      scenario: { type: 'string' }, fix_idea: { type: 'string' },
    }, required: ['pr', 'title', 'file', 'line', 'severity', 'lens', 'scenario', 'fix_idea'] } },
    good: { type: 'string' },
  },
  required: ['tests_run', 'findings', 'good'],
}

const VERDICTS = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: { type: 'object', properties: {
    index: { type: 'number' }, real: { type: 'boolean' },
    severity: { type: 'string', enum: ['blocking', 'should-fix', 'minor'] }, reason: { type: 'string' },
  }, required: ['index', 'real', 'severity', 'reason'] } } },
  required: ['verdicts'],
}

const results = await pipeline(
  args.groups,
  (g) => agent(
    `${BASE}\n\nТема: ${g.title}. PR (номер, sha): ${g.prs}. Свою копию называй qa-${g.key}.\n\n${LENSES}`,
    { label: `поиск:${g.key}`, phase: 'Поиск', schema: FINDINGS },
  ),
  (found, g) => {
    const list = found?.findings ?? []
    if (list.length === 0) return { group: g.key, title: g.title, found, verdicts: [] }
    return agent(
      `${BASE}\n\nДругой проверяющий нашёл в теме «${g.title}» дефекты ниже. Каждый попробуй ОПРОВЕРГНУТЬ: пройди по коду origin/main от реального вызова до заявленного исхода. Настоящий — только если путь реален; сомневаешься — real=false. Уточни severity. Копию (если нужна) называй qa-${g.key}-v.\n\nНАХОДКИ:\n${list.map((f, i) => `[${i}] PR #${f.pr} ${f.file}:${f.line ?? ''} (${f.severity}, ${f.lens}) ${f.title}\nсценарий: ${f.scenario}\nидея правки: ${f.fix_idea}`).join('\n\n')}`,
      { label: `опровержение:${g.key}`, phase: 'Опровержение', schema: VERDICTS },
    ).then((v) => ({ group: g.key, title: g.title, found, verdicts: v?.verdicts ?? [] }))
  },
)

return results.filter(Boolean).map((r) => {
  const judged = (r.found?.findings ?? []).map((f, i) => ({ ...f, verdict: (r.verdicts ?? []).find((v) => v.index === i) }))
  return {
    group: r.group,
    title: r.title,
    tests_run: r.found?.tests_run,
    good: r.found?.good,
    confirmed: judged.filter((f) => f.verdict?.real),
    rejected: judged.filter((f) => !f.verdict?.real).map((f) => ({ pr: f.pr, title: f.title, why: f.verdict?.reason ?? 'вердикта нет' })),
  }
})
