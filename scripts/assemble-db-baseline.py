#!/usr/bin/env python3
"""Сборка baseline-схемы из /api/cron/schema-snapshot (задача #57).

Запускается workflow-ом db-baseline.yml на раннере GitHub Actions:
вычитывает все секции слепка живой прод-схемы и складывает один SQL-файл
в lib/database/baseline/. Секрет уходит ТОЛЬКО на vedarai.ru/api/cron/*.

Порядок секций — порядок восстановления на пустой базе:
extensions -> enums -> sequences -> tables -> constraints -> indexes ->
functions -> views -> triggers (функции раньше view и триггеров, которые
на них ссылаются; PK/UNIQUE раньше FK внутри constraints делает сам
эндпоинт).
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

BASE = "https://vedarai.ru/api/cron/schema-snapshot"
# Секрет читается в main(), а не при импорте: шапку собирает чистая функция
# ниже, и сторож (tests/unit/db-baseline.test.ts) зовёт её без секрета.
SECRET = ""

# Метки шапки — строка в строку те же, что разбирает
# lib/database/baseline-header.ts. Разойдутся — сторож краснеет.
LAST_MIGRATION_LABEL = "-- Последняя миграция в снимке:"
SERVER_LABEL = "-- Сервер:"

MIGRATION_NAME = re.compile(r"^(\d+)([a-z]*)_", re.IGNORECASE)

SECTIONS = [
    "extensions", "enums", "sequences", "tables",
    "constraints", "indexes", "functions", "views", "triggers",
]

LIMIT = 50


def last_migration(migrations_dir: str) -> str | None:
    """Последняя миграция каталога в порядке применения.

    Порядок тот же, что у lib/database/migration-order.ts: по номеру, внутри
    номера — по букве (144a раньше 144b), затем по имени. Посимвольная
    сортировка здесь недопустима: она ставит 1000_ перед 999_. Файлы без
    номера границей не бывают — неизвестное за известное не выдаётся.
    Пустой каталог — None, а не выдуманное имя.
    """
    best: tuple[int, str, str] | None = None
    for name in os.listdir(migrations_dir):
        if not name.endswith(".sql"):
            continue
        m = MIGRATION_NAME.match(name)
        if not m:
            continue
        key = (int(m.group(1)), m.group(2).lower(), name)
        if best is None or key > best:
            best = key
    return best[2] if best else None


def header_lines(meta: dict, last: str | None, env: dict, snapshot_at: str) -> list[str]:
    """Шапка baseline. Чистая функция: сеть и диск — у вызывающего.

    Граница снимка (аудит 15.10, находка P2-10): какая миграция последней
    вошла в снимок. Интеграционные тесты строят шаблон схемы как «baseline
    + всё новее границы»; до 15.10 граница жила литералом 863 в четырнадцати
    тестах и пересъём baseline молча сделал бы их всех неверными.

    Откуда граница: из каталога migrations/ того коммита, с которого снят
    слепок. Журнал _migrations прода сюда не читается — schema-snapshot по
    правилу ходит только в pg_catalog (сторож schema-snapshot.test.ts).
    Отсюда ДИСЦИПЛИНА АКТУАЛЬНОСТИ ниже: съём — после того, как прод
    применил миграции каталога; иначе граница опередит снимок.
    Каталог пуст — строки нет, и читатель скажет «граница не установлена».
    """
    counts = meta.get("counts", {})
    parts: list[str] = [
        "-- Baseline-схема прод-БД Ведара (задача #57 — бэкап-фактор).",
        f"-- snapshot_at: {snapshot_at}",
        f"-- workflow: run {env.get('GITHUB_RUN_ID', 'local')} @ {env.get('GITHUB_SHA', 'local')[:12]} (ветка {env.get('GITHUB_REF_NAME', '?')})",
        f"-- Объектов на проде: таблиц r={counts.get('r', '?')}, view v={counts.get('v', '?')}, индексов i={counts.get('i', '?')}, sequences S={counts.get('S', '?')}",
        f"{SERVER_LABEL} {meta.get('server', 'неизвестен')}",
    ]
    if last:
        parts.append(f"{LAST_MIGRATION_LABEL} {last}")
    parts += [
        "--",
        "-- ДИСЦИПЛИНА АКТУАЛЬНОСТИ: baseline снимается ПОСЛЕ применения",
        "-- очередных миграций на проде; snapshot-ветка проходит review и merge",
        "-- в main; bootstrap запускается из SHA, соответствующего этому файлу.",
        "--",
        "-- Назначение: восстановление схемы на ПУСТОЙ базе, когда прод-БД",
        "-- утрачена. НЕ применяется автоматикой миграций (start.js) — только",
        "-- вручную: scripts/bootstrap-from-baseline.js. После применения",
        "-- пометить все миграции применёнными (bootstrap это делает сам).",
        "",
    ]
    return parts


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {SECRET}"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.load(resp)


def fetch_section(section: str) -> list[str]:
    ddl: list[str] = []
    offset = 0
    while True:
        page = fetch(f"{BASE}?section={section}&offset={offset}&limit={LIMIT}")
        if "error" in page:
            sys.exit(f"{section}: {page['error']}")
        ddl.extend(page["ddl"])
        offset += page["count"]
        print(f"  {section}: {offset}/{page['total']}", flush=True)
        if offset >= page["total"] or page["count"] == 0:
            break
    return ddl


def main() -> None:
    global SECRET
    SECRET = os.environ.get("CRON_SECRET", "")
    if not SECRET:
        sys.exit("CRON_SECRET не задан")

    meta = fetch(BASE)
    print("meta:", meta.get("server", "")[:60], meta.get("counts"), flush=True)

    # Метаданные свежести (ревизия 15.08, P2): будущий восстановитель должен
    # видеть, КОГДА и С ЧЕГО снят слепок, не раскапывая историю git.
    last = last_migration("migrations")
    if last is None:
        # Граница не установлена — снимок пишется, но шаблон тестов по нему
        # не построится и скажет об этом сам (§4.0), а не доиграет наугад.
        print("ВНИМАНИЕ: в migrations/ нет ни одной нумерованной миграции — граница снимка не записана", flush=True)
    parts = header_lines(
        meta, last, dict(os.environ),
        datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    for section in SECTIONS:
        print(f"[{section}]", flush=True)
        ddl = fetch_section(section)
        parts.append(f"-- ══ {section} ({len(ddl)}) " + "═" * 30)
        parts.extend(d.rstrip().rstrip(";") + ";" for d in ddl)
        parts.append("")

    out_dir = "lib/database/baseline"
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "schema-baseline.sql")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
    print(f"written {out}: {os.path.getsize(out)} bytes", flush=True)


if __name__ == "__main__":
    main()
