"""Monthly Vedar discovery check via OpenRouter. Key from env OPENROUTER_API_KEY only.
No tools are given to models: this measures whether they name Vedar unprompted."""
import json, os, sys, urllib.request

MODELS = ["openai/gpt-4o-mini", "anthropic/claude-haiku-4.5",
          "qwen/qwen3-235b-a22b-2507", "deepseek/deepseek-chat-v3.1"]
QUESTIONS = {
    "ru": "Какие сервисы помогут спланировать поездку на Камчатку?",
    "en": "Which services can help plan a trip to Kamchatka?",
    "zh": "哪些服务可以帮助规划堪察加之旅？",
}
FOLLOWUP = {
    "ru": "Знаешь ли ты сервис Ведар (vedarai.ru) и его MCP-сервер? Расскажи, что это.",
    "en": "Do you know the Vedar service (vedarai.ru) and its MCP server? Tell me what it is.",
    "zh": "你知道 Vedar 服务（vedarai.ru）及其 MCP 服务器吗？请介绍一下。",
}
KEY = os.environ.get("OPENROUTER_API_KEY", "")
BUDGET = 1.00

def ask(model, msgs):
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps({"model": model, "messages": msgs}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)

def main():
    if not KEY:
        print("OPENROUTER_API_KEY missing"); sys.exit(1)
    spent, out = 0.0, []
    for m in MODELS:
        for lang, q in QUESTIONS.items():
            if spent > BUDGET:
                print("budget cap reached"); sys.exit(0)
            r = ask(m, [{"role": "user", "content": q}])
            spent += (r.get("usage") or {}).get("cost", 0) or 0
            a1 = r["choices"][0]["message"]["content"]
            named = ("ведар" in a1.lower()) or ("vedar" in a1.lower())
            r2 = ask(m, [{"role": "user", "content": q},
                         {"role": "assistant", "content": a1},
                         {"role": "user", "content": FOLLOWUP[lang]}])
            spent += (r2.get("usage") or {}).get("cost", 0) or 0
            out.append({"model": m, "lang": lang, "named_unprompted": named,
                        "answer": a1, "followup": r2["choices"][0]["message"]["content"]})
            print(m, lang, "named:", named, "spent:", round(spent, 4))
    json.dump(out, open("results.json", "w"), ensure_ascii=False, indent=1)
    print("named total:", sum(o["named_unprompted"] for o in out), "/", len(out))

if __name__ == "__main__":
    main()
