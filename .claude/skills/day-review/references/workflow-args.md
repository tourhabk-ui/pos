# Запуск разборов: параметры и вызов

Читать перед шагом 2 (разбор) или шагом 3 (качество), когда факты шага 1
уже собраны.

## Как заполнить группы

- Группа — смысловая тема, а не автор: прокат, Кузьмич, роли в
  мессенджерах, сайт и аналитика. 4–5 групп; больше — дробит внимание,
  меньше — один агент тонет в двух десятках PR.
- `prs` — строка «#номер sha, …», sha — из `git log` шага 1 (короткий
  годится). Служебные коммиты (README-stats, DB_SCHEMA, пробы) — в
  группу «сайт и служебное», чтобы проверка полноты не нашла «пропуск».
- `openPrs` — все открытые PR, созданные или обновлённые в окне; старые
  dependabot-PR не нужны.
- `digestIssues` — issue с `[digest]` в заголовке, созданные в окне.
- `otherIssues` — прочие новые issue: метки agent-proposal, evo, внешние.

## Вызов: прогресс

```js
Workflow({
  scriptPath: '/home/user/pos/.claude/skills/day-review/scripts/progress.workflow.js',
  args: {
    window: { from: '2026-10-23T21:55:00Z', to: '2026-10-24T21:55:00Z' },
    groups: [
      { key: 'prokat', title: 'Прокат машин', prs: '#2750 b6d3750a0, #2751 7853c2dd3' },
      { key: 'kuzmich', title: 'Кузьмич и чат оператора', prs: '#2756 fbdef9ec8, #2763 edff2ff3b' },
    ],
    openPrs: [{ pr: 2761, branch: 'cursor/incoming-request-card-2834' }],
    digestIssues: [2769, 2740],
    otherIssues: [2767, 2755],
  },
})
```

## Вызов: качество

```js
Workflow({
  scriptPath: '/home/user/pos/.claude/skills/day-review/scripts/quality.workflow.js',
  args: {
    window: { from: '2026-10-23T21:55:00Z', to: '2026-10-24T21:55:00Z' },
    scratch: '<каталог scratchpad сессии>',
    groups: [ /* те же группы, что в прогрессе */ ],
  },
})
```

## Что вернётся

Итог лежит в файле задачи, путь называет уведомление о завершении. Это
JSON с ключом `result`, и он большой. Выпиши его в файл scratchpad и читай
страницами:

```bash
python3 -c "import json;d=json.load(open('<файл задачи>'))['result'];print(json.dumps(d,ensure_ascii=False,indent=1))" > <scratchpad>/review.json
```

Прогресс возвращает поля `groups`, `open_prs`, `digest`, `proposals` и
`critic`. Сначала прочитай `critic.wrong_claims`: исправь эти утверждения
в отчёте, прежде чем его писать. Качество возвращает по каждой теме
`confirmed`, `rejected` и `tests_run`. В отчёт идёт только `confirmed`.
