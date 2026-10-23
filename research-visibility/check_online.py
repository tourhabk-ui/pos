"""One-off Vedar visibility check with web search (:online). Unprompted question only,
no link, no follow-up. Key from env OPENROUTER_API_KEY only; never printed."""
import json, os, sys, urllib.request

MODELS = ["openai/gpt-4o-mini", "anthropic/claude-haiku-4.5",
          "qwen/qwen3-235b-a22b-2507", "deepseek/deepseek-chat-v3.1"]
QUESTIONS = {
    "ru": "Какие сервисы помогут спланировать поездку на Камчатку?",
    "en": "Which services can help plan a trip to Kamchatka?",
    "zh": "哪些服务可以帮助规划堪察加之旅？",
}
KEY = os.environ.get("OPENROUTER_API_KEY", "")
BUDGET = 0.50
RESERVE = 0.05  # worst-case cost of one more online call

def ask(model, msgs):
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps({"model": model + ":online", "messages": msgs, "usage": {"include": True}}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)

def main():
    if not KEY:
        print("OPENROUTER_API_KEY missing"); sys.exit(1)
    spent, out = 0.0, []
    for m in MODELS:
        for lang, q in QUESTIONS.items():
            if spent + RESERVE > BUDGET:
                print("budget cap reached"); break
            try:
                r = ask(m, [{"role": "user", "content": q}])
            except Exception as e:
                out.append({"model": m, "lang": lang, "error": str(e)[:200]}); print(m, lang, "error"); continue
            spent += (r.get("usage") or {}).get("cost", 0) or 0
            msg = r["choices"][0]["message"]
            a = msg.get("content") or ""
            urls = [x.get("url_citation", {}).get("url") for x in (msg.get("annotations") or []) if x.get("type") == "url_citation"]
            low = a.lower() + " " + " ".join(u or "" for u in urls).lower()
            named = "ведар" in low or "vedar" in low
            out.append({"model": m, "lang": lang, "named_unprompted": named, "answer": a, "citations": urls})
            print(m, lang, "named:", named, "spent:", round(spent, 4))
    json.dump(out, open("results.json", "w"), ensure_ascii=False, indent=1)
    print("named total:", sum(o.get("named_unprompted", False) for o in out), "/", len(out), "spent:", round(spent, 4))

if __name__ == "__main__":
    main()
