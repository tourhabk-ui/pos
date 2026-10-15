#!/usr/bin/env python3
"""
Ведар ↔ любой LLM с OpenAI-совместимым API (DeepSeek, Qwen, Kimi, Doubao, GLM...).

Почему мост, а не MCP-коннектор: vedarai.ru/api/mcp — stateless JSON-RPC
без OAuth и без сессий. Готовые MCP-коннекторы платформ под него не подходят.
Этот скрипт приводит тулы MCP к обычному function calling, который понимают
все перечисленные провайдеры.

Ноль зависимостей — только стандартная библиотека.

Быстрый старт:
    export LLM_API_KEY=sk-...
    python3 vedar_mcp_bridge.py                      # интерактив
    python3 vedar_mcp_bridge.py "статус Горелого"    # один вопрос

Провайдеры:
    DeepSeek  export LLM_PROVIDER=deepseek
    Qwen      export LLM_PROVIDER=qwen      # или DASHSCOPE_API_KEY=...
    Kimi      export LLM_PROVIDER=moonshot
    Doubao    export LLM_PROVIDER=doubao
    GLM       export LLM_PROVIDER=glm
    любая     export LLM_BASE_URL=... LLM_MODEL=... LLM_API_KEY=...

Служебные режимы:
    --tools              список тулов
    --schema out.json    дамп tools/list в OpenAI-формате (для импорта куда угодно)
    --call NAME '{}'     один вызов тула напрямую, без LLM
    --serve 8080         HTTP-эндпоинт POST /chat для веб-морды/фронта
    --doctor             проверить ключ, base_url и доступность MCP
"""

import json
import os
import sys
import urllib.error
import urllib.request

MCP_URL = os.environ.get("MCP_URL", "https://vedarai.ru/api/mcp")
TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "90"))
MAX_TURNS = int(os.environ.get("MAX_TURNS", "8"))

# Имя клиента, которое видит журнал Ведара (/hub/admin/mcp, mcp-census).
# По умолчанию «vedar-mcp-bridge» — так приходят люди, скачавшие мост, и это
# спрос. Свои пробы (china-bridge-probe.yml) ставят MCP_CLIENT_NAME=
# vedar-mcp-bridge-probe: слово «probe» журнал относит к проверкам
# (lib/mcp/probe-clients, PROBE_NAME_PATTERN), и прогоны с раннера больше не
# раздувают спрос КНР (аудит 15.10, CN-quick).
DEFAULT_CLIENT_NAME = "vedar-mcp-bridge"


def client_name(provider=None):
    base = (os.environ.get("MCP_CLIENT_NAME") or "").strip() or DEFAULT_CLIENT_NAME
    return f"{base}/{provider}" if provider else base


# Внутри VedarMCP.__init__ имя client_name занято прежним параметром
# конструктора, поэтому функция зовётся там через этот псевдоним.
_default_client_name = client_name

PROVIDERS = {
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        # deepseek-chat снят 26.07.2026 (ответ провайдера: «supported API model
        # names are deepseek-v4-pro or deepseek-v4-flash»); flash — дешёвый.
        "model": "deepseek-v4-flash",
        "key_env": ("LLM_API_KEY", "DEEPSEEK_API_KEY"),
    },
    "qwen": {
        # Ключ DashScope привязан к контуру: китайский — dashscope.aliyuncs.com,
        # международный — dashscope-intl.aliyuncs.com (LLM_BASE_URL=...).
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
        "key_env": ("LLM_API_KEY", "DASHSCOPE_API_KEY"),
    },
    "moonshot": {
        "base_url": "https://api.moonshot.cn/v1",
        "model": "moonshot-v1-8k",
        "key_env": ("LLM_API_KEY", "MOONSHOT_API_KEY"),
    },
    "doubao": {
        # ark.cn-beijing.volces.com/api/v3, model = твой endpoint-id из консоли
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "model": None,
        "key_env": ("LLM_API_KEY", "ARK_API_KEY"),
    },
    "glm": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model": "glm-4-flash",
        "key_env": ("LLM_API_KEY", "ZAI_API_KEY", "ZHIPUAI_API_KEY"),
    },
}

WRITE_TOOLS = {
    "create_lead",
    "create_booking_request",
    "create_stay_request",
    "request_charter",
}

SYSTEM_PROMPT = """Ты помощник по Камчатке. Отвечай на том языке, на котором задан вопрос.

Данные бери ТОЛЬКО из инструментов. Чего в базе нет — не выдумывай,
не называй точных дат и мест по памяти: говори, что данных нет.

Инструменты с безопасностью (safety_status, get_guardian_context,
get_volcano_status, get_weather) вызывай ДО того, как советовать поездку,
и всегда упоминай предупреждения, если они есть.

Писательные инструменты (create_lead, create_booking_request,
create_stay_request, request_charter) вызывай ТОЛЬКО если пользователь
в этом же диалоге явно сказал, что он согласен на обработку данных,
и только с теми данными, которые он назвал сам. Никогда не подставляй
свой телефон, имя или согласие от себя.

Заявка — это не бронь: мест она не закрепляет, оплата идёт напрямую.
Говори об этом пользователю.

Экстренный вызов на Камчатке — 112."""


# ---------------------------------------------------------------- конфиг

def resolve_config():
    provider = os.environ.get("LLM_PROVIDER", "").strip().lower()
    preset = PROVIDERS.get(provider, {})

    base_url = os.environ.get("LLM_BASE_URL") or preset.get("base_url")
    model = os.environ.get("LLM_MODEL") or preset.get("model")
    key = os.environ.get("LLM_API_KEY") or ""

    if not key:
        for name in preset.get("key_env", ()):
            key = os.environ.get(name) or ""
            if key:
                break

    return {
        "provider": provider or "(custom)",
        "base_url": (base_url or "").rstrip("/"),
        "model": model,
        "key": key,
    }


# ---------------------------------------------------------------- HTTP

def _post(url, payload, headers, timeout=TIMEOUT):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    if not raw.strip():
        raise RuntimeError(f"Пустой ответ от {url}")
    if raw.lstrip().startswith(("event:", "data:")):
        chunks = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")]
        raw = chunks[-1] if chunks else "{}"
    return json.loads(raw)


# ---------------------------------------------------------------- MCP

class VedarMCP:
    def __init__(self, url=MCP_URL, name=None, *, client_name=None):
        # client_name — прежнее имя параметра (до 15.10 он назывался так).
        # Мост скачивают люди, и их VedarMCP(client_name="...") должен работать
        # как раньше, а не падать с TypeError (аудит 15.10, W3-china). Основной
        # параметр — name; оба сразу — ошибка с понятной причиной, а не
        # молчаливый выбор одного из двух.
        if name is not None and client_name is not None:
            raise TypeError(
                "VedarMCP: имя клиента задаётся одним параметром — name "
                "(client_name — его прежнее имя, оставлено для совместимости)"
            )
        self.url = url
        # Имя клиента видит журнал Ведара (/hub/admin/mcp): с провайдером в
        # имени видно, какая модель стоит за мостом, иначе все мосты — одно.
        self.client_name = name or client_name or _default_client_name()
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self._id = 0
        self.server_info = None

    def _rpc(self, method, params=None, timeout=TIMEOUT):
        self._id += 1
        out = _post(
            self.url,
            {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}},
            self.headers,
            timeout,
        )
        if "error" in out:
            raise RuntimeError(f"MCP error: {out['error']}")
        return out.get("result", {})

    def initialize(self):
        res = self._rpc(
            "initialize",
            {
                # Ревизия Streamable HTTP (один POST-эндпоинт); сервер
                # принимает 2025-06-18, 2025-03-26 и 2024-11-05.
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": self.client_name, "version": "1.2"},
            },
        )
        self.server_info = res.get("serverInfo")
        return res

    def list_tools(self):
        return self._rpc("tools/list").get("tools", [])

    def call_tool(self, name, args):
        res = self._rpc("tools/call", {"name": name, "arguments": args}, timeout=120)
        parts = []
        for block in res.get("content", []):
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
            else:
                parts.append(json.dumps(block, ensure_ascii=False))
        if res.get("isError"):
            return "ОШИБКА ИНСТРУМЕНТА: " + "\n".join(parts)
        return "\n".join(parts) or "(пустой результат)"


def to_openai_tools(tools):
    out = []
    for t in tools:
        schema = t.get("inputSchema") or {"type": "object", "properties": {}}
        if schema.get("type") != "object":
            schema = {"type": "object", "properties": schema}
        schema.setdefault("properties", {})
        out.append({
            "type": "function",
            "function": {
                "name": t["name"],
                "description": (t.get("description") or "").strip()[:1024],
                "parameters": schema,
            },
        })
    return out


# ---------------------------------------------------------------- LLM

def llm_chat(cfg, messages, tools):
    if not cfg["key"]:
        raise RuntimeError("Не задан ключ: LLM_API_KEY (или DASHSCOPE_API_KEY и т.п.)")
    if not cfg["model"]:
        raise RuntimeError("Не задана модель: LLM_MODEL (у Doubao это endpoint-id)")
    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": 0.2,
    }
    # Пустой список инструментов не посылаем: DashScope отвечает 400
    # «[] is too short - 'tools'» (прогон 1, 13.10), а --doctor зовёт модель
    # как раз без инструментов.
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    res = _post(
        f"{cfg['base_url']}/chat/completions",
        payload,
        {"Content-Type": "application/json", "Authorization": f"Bearer {cfg['key']}"},
    )
    return res["choices"][0]["message"]


# ---------------------------------------------------------------- агент

class Agent:
    def __init__(self, cfg):
        self.cfg = cfg
        self.mcp = VedarMCP(name=client_name(cfg["provider"]))
        info = self.mcp.initialize().get("serverInfo", {})
        self.tools = to_openai_tools(self.mcp.list_tools())
        self.title = info.get("title") or info.get("name")
        self.version = info.get("version", "?")
        self.history = [{"role": "system", "content": SYSTEM_PROMPT}]

    def say(self, text):
        info = f"[{self.title} v{self.version} | тулов: {len(self.tools)} | "
        print(f"{info}{self.cfg['provider']}:{self.cfg['model']}]", file=sys.stderr)
        return text

    def run(self, user_input):
        self.history.append({"role": "user", "content": user_input})

        for _ in range(MAX_TURNS):
            msg = llm_chat(self.cfg, self.history, self.tools)
            calls = msg.get("tool_calls") or []
            entry = {"role": "assistant", "content": msg.get("content") or ""}
            if calls:
                entry["tool_calls"] = calls
            self.history.append(entry)

            if not calls:
                return entry["content"]

            for call in calls:
                fn = call["function"]["name"]
                try:
                    args = json.loads(call["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}

                if fn in WRITE_TOOLS and not args.get("consent"):
                    args.pop("consent", None)
                    result = (
                        "Согласие пользователя на обработку данных не подтверждено. "
                        "Спроси его явно и передай ответ сюда — до этого заявку не отправляем."
                    )
                else:
                    print(
                        f"  -> {fn} {json.dumps(args, ensure_ascii=False)[:180]}",
                        file=sys.stderr,
                    )
                    result = self.mcp.call_tool(fn, args)

                self.history.append({
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": result,
                })

        return "Достигнут лимит шагов. Сформулируй запрос проще."


# ---------------------------------------------------------------- режимы

def interactive(agent):
    print(agent.say("Интерактив. /tools — список, /clear — сброс диалога, Ctrl-C — выход.\n"))
    while True:
        try:
            q = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not q:
            continue
        if q == "/tools":
            for t in agent.tools:
                params = ", ".join(t["function"]["parameters"]["properties"].keys())
                print(f"  {t['function']['name']}({params})")
            continue
        if q == "/clear":
            agent.history = agent.history[:1]
            print("диалог сброшен")
            continue
        try:
            print(agent.run(q))
        except Exception as exc:  # noqa: BLE001 — CLI должен жить
            print(f"ошибка: {exc}", file=sys.stderr)


def serve(port, cfg):
    from http.server import BaseHTTPRequestHandler, HTTPServer

    agent = Agent(cfg)
    agent.say(f"HTTP на :{port} — POST /chat {{\"message\": \"...\"}}")

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/tools":
                self._send(200, {"tools": agent.tools})
            else:
                self._send(404, {"error": "use POST /chat or GET /tools"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                message = payload.get("message") or payload.get("messages", [{}])[-1].get("content")
                if not message:
                    raise ValueError("нужно поле message")
                self._send(200, {"reply": agent.run(message)})
            except Exception as exc:  # noqa: BLE001
                self._send(400, {"error": str(exc)})

        def log_message(self, *_):
            pass

    HTTPServer(("0.0.0.0", port), Handler).serve_forever()


def doctor(cfg):
    mcp = VedarMCP()
    info = mcp.initialize().get("serverInfo", {})
    tools = mcp.list_tools()
    print(f"MCP      {MCP_URL}")
    print(f"          {info.get('title')} v{info.get('version')}, тулов: {len(tools)}")
    print(f"Провайдер {cfg['provider']}")
    print(f"base_url  {cfg['base_url'] or '— НЕ ЗАДАН —'}")
    print(f"модель    {cfg['model'] or '— НЕ ЗАДАНА —'}")
    print(f"ключ      {'задан' if cfg['key'] else '— НЕ ЗАДАН —'}")
    if not (cfg["key"] and cfg["base_url"] and cfg["model"]):
        print("\nБез ключа LLM-часть не заработает, MCP-часть работает.")
        return
    try:
        llm_chat(cfg, [{"role": "user", "content": "скажи ок"}], [])
        print("LLM       отвечает, всё собрано")
    except urllib.error.HTTPError as exc:
        print(f"LLM       HTTP {exc.code}: {exc.read()[:200].decode('utf-8', 'replace')}")
        # Модели у провайдеров живут недолго (deepseek-chat снят 26.07.2026):
        # на отказ — показать, какие id принимает этот ключ, а не гадать.
        try:
            req = urllib.request.Request(
                f"{cfg['base_url']}/models",
                headers={"Authorization": f"Bearer {cfg['key']}"},
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                ids = [m.get("id") for m in json.loads(resp.read().decode("utf-8")).get("data", [])]
            print(f"модели    ключ принимает {len(ids)}: {', '.join(i for i in ids[:20] if i)}")
        except Exception as exc2:  # noqa: BLE001
            print(f"модели    список не прочитан: {exc2}")
    except Exception as exc:  # noqa: BLE001
        print(f"LLM       ошибка: {exc}")


def main():
    args = sys.argv[1:]
    cfg = resolve_config()

    if "--tools" in args:
        mcp = VedarMCP()
        mcp.initialize()
        for t in mcp.list_tools():
            params = ", ".join((t.get("inputSchema") or {}).get("properties", {}).keys())
            print(f"{t['name']}({params})")
        return

    if "--schema" in args:
        idx = args.index("--schema")
        path = args[idx + 1] if len(args) > idx + 1 else "vedar_tools.json"
        mcp = VedarMCP()
        mcp.initialize()
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(to_openai_tools(mcp.list_tools()), fh, ensure_ascii=False, indent=2)
        print(f"схема {len(to_openai_tools(mcp.list_tools()))} тулов → {path}")
        return

    if "--call" in args:
        idx = args.index("--call")
        name = args[idx + 1]
        arguments = json.loads(args[idx + 2]) if len(args) > idx + 2 else {}
        mcp = VedarMCP()
        mcp.initialize()
        print(mcp.call_tool(name, arguments))
        return

    if "--doctor" in args:
        doctor(cfg)
        return

    if "--serve" in args:
        idx = args.index("--serve")
        port = int(args[idx + 1]) if len(args) > idx + 1 and args[idx + 1].isdigit() else 8080
        serve(port, cfg)
        return

    question = " ".join(a for a in args if not a.startswith("-"))
    if question:
        print(Agent(cfg).run(question))
    else:
        interactive(Agent(cfg))


if __name__ == "__main__":
    main()