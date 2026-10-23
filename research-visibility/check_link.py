"""One-off Vedar link probe via OpenRouter. Key from env OPENROUTER_API_KEY only, never printed."""
import json, os, sys, urllib.request
MODELS = ["openai/gpt-4o-mini", "anthropic/claude-haiku-4.5",
          "qwen/qwen3-235b-a22b-2507", "deepseek/deepseek-chat-v3.1"]
Q = {"ru": "Что такое https://vedarai.ru/api/mcp и протокол A2A? Расскажи, что это за сервис.",
     "en": "What is https://vedarai.ru/api/mcp and the A2A protocol? Tell me what this service is."}
KEY = os.environ.get("OPENROUTER_API_KEY", ""); BUDGET = 1.00
def ask(model, q):
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps({"model": model, "messages": [{"role": "user", "content": q}]}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r: return json.load(r)
def main():
    if not KEY: print("OPENROUTER_API_KEY missing"); sys.exit(1)
    spent, out = 0.0, []
    for variant in ["", ":online"]:
        for m in MODELS:
            for lang, q in Q.items():
                if spent > BUDGET: print("budget cap reached"); break
                try:
                    r = ask(m + variant, q); c = (r.get("usage") or {}).get("cost", 0) or 0
                    spent += c; a = r["choices"][0]["message"]["content"]; err = None
                except Exception as e:
                    a, err = "", str(e)[:300]
                out.append({"model": m + variant, "lang": lang, "answer": a, "error": err})
                print(m + variant, lang, "ok" if not err else "ERR " + err, "spent:", round(spent, 4))
    json.dump(out, open("results.json", "w"), ensure_ascii=False, indent=1)
    print("total spent:", round(spent, 4))
if __name__ == "__main__": main()
