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
import sys
import urllib.request
from datetime import date

BASE = "https://vedarai.ru/api/cron/schema-snapshot"
SECRET = os.environ.get("CRON_SECRET", "")
if not SECRET:
    sys.exit("CRON_SECRET не задан")

SECTIONS = [
    "extensions", "enums", "sequences", "tables",
    "constraints", "indexes", "functions", "views", "triggers",
]

LIMIT = 50


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
    meta = fetch(BASE)
    print("meta:", meta.get("server", "")[:60], meta.get("counts"), flush=True)

    parts: list[str] = [
        "-- Baseline-схема прод-БД Ведара (задача #57 — бэкап-фактор).",
        f"-- Снята {date.today().isoformat()} c /api/cron/schema-snapshot (только pg_catalog, без данных).",
        f"-- Сервер: {meta.get('server', 'неизвестен')}",
        "--",
        "-- Назначение: восстановление схемы на ПУСТОЙ базе, когда прод-БД",
        "-- утрачена. НЕ применяется автоматикой миграций (start.js) — только",
        "-- вручную: scripts/bootstrap-from-baseline.js. После применения",
        "-- пометить все миграции применёнными (bootstrap это делает сам).",
        "",
    ]
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
