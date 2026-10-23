"""One-off two-turn dialog probe via OpenRouter. Key from env only, never printed.
v2. Write tools are STUBBED: nothing is sent to Vedar for any create_* tool (incl. create_car_rental_request) or request_charter."""
import json, os, sys, urllib.request
MODELS = ["openai/gpt-4o-mini", "anthropic/claude-haiku-4.5",
          "qwen/qwen3-235b-a22b-2507", "deepseek/deepseek-chat-v3.1"]
T1 = "Что такое https://vedarai.ru/api/mcp и протокол A2A? Расскажи, что это за сервис."
T2 = "Хочу арендовать внедорожник на Камчатке с 10 по 14 ноября, оформи пробную заявку."
STUB = {"create_lead", "create_booking_request", "create_stay_request", "request_charter", "create_car_rental_request"}
def stubbed(n): return n in STUB or n.startswith("create_")
MCP = "https://vedarai.ru/api/mcp"
KEY = os.environ.get("OPENROUTER_API_KEY", ""); BUDGET = 1.00; spent = 0.0
def post(url, body, hdr):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=hdr)
    with urllib.request.urlopen(req, timeout=180) as r: return json.load(r)
def mcp(method, params):
    return post(MCP, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
def llm(model, msgs, tools=None):
    global spent
    b = {"model": model, "messages": msgs}
    if tools: b["tools"] = tools
    r = post("https://openrouter.ai/api/v1/chat/completions", b,
             {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    spent += (r.get("usage") or {}).get("cost", 0) or 0
    return r["choices"][0]["message"]
def turn(model, msgs, tools, log):
    for _ in range(8):
        if spent > BUDGET: log.append({"note": "budget cap"}); return "BUDGET CAP"
        m = llm(model, msgs, tools)
        calls = m.get("tool_calls") or []
        msgs.append({"role": "assistant", "content": m.get("content") or "", **({"tool_calls": calls} if calls else {})})
        if not calls: return m.get("content") or ""
        for c in calls:
            name = c["function"]["name"]
            try: args = json.loads(c["function"].get("arguments") or "{}")
            except Exception: args = {}
            if stubbed(name):
                res = "TEST STUB: заявка НЕ отправлена (пробный режим проверки). Data not sent."
                log.append({"tool": name, "args": args, "stubbed": True})
            else:
                try:
                    r = mcp("tools/call", {"name": name, "arguments": args})
                    res = "".join(x.get("text", "") for x in r.get("result", {}).get("content", []))[:6000]
                except Exception as e: res = "error: " + str(e)[:200]
                log.append({"tool": name, "args": args, "stubbed": False})
            msgs.append({"role": "tool", "tool_call_id": c["id"], "content": res})
    return msgs[-1].get("content", "")
def main():
    if not KEY: print("OPENROUTER_API_KEY missing"); sys.exit(1)
    tl = mcp("tools/list", {})["result"]["tools"]
    tools = [{"type": "function", "function": {"name": t["name"], "description": t.get("description", "")[:1000],
              "parameters": t.get("inputSchema") or {"type": "object", "properties": {}}}} for t in tl]
    out = []
    for variant in ["online", "tools"]:
        for m in MODELS:
            model = m + ":online" if variant == "online" else m
            tt = tools if variant == "tools" else None
            msgs, log, a1, a2, err = [], [], "", "", None
            try:
                msgs.append({"role": "user", "content": T1}); a1 = turn(model, msgs, tt, log)
                msgs.append({"role": "user", "content": T2}); a2 = turn(model, msgs, tt, log)
            except Exception as e: err = str(e)[:300]
            out.append({"model": model, "variant": variant, "turn1": a1, "turn2": a2, "tool_log": log, "error": err})
            print(model, variant, "tools:", [x.get("tool") for x in log], "err:", err, "spent:", round(spent, 4))
    json.dump(out, open("results.json", "w"), ensure_ascii=False, indent=1)
    print("total spent:", round(spent, 4))
if __name__ == "__main__": main()
