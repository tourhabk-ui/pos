#!/usr/bin/env python3
"""
Sync .env.local → Timeweb app environment variables.
Usage: TIMEWEB_TOKEN=<token> python3 scripts/sync-envs-to-timeweb.py
"""
import json
import os
import subprocess
import sys
from pathlib import Path

APP_ID = os.getenv("TIMEWEB_APP_ID", "883095")
TOKEN  = os.getenv("TIMEWEB_TOKEN", "")
BASE   = "https://api.timeweb.cloud/api/v1"

if not TOKEN:
    print("ERROR: TIMEWEB_TOKEN env var not set")
    sys.exit(1)

# Read .env.local from repo root
env_file = Path(__file__).parent.parent / ".env.local"
if not env_file.exists():
    print(f"ERROR: {env_file} not found")
    sys.exit(1)

SECRET_KEYS = {
    "DATABASE_URL", "JWT_SECRET", "NEXTAUTH_SECRET",
    "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "MINIMAX_API_KEY",
    "XAI_API_KEY", "OPENROUTER_API_KEY", "OR_API_KEY",
    "OPENROUTER_MANAGEMENT_KEY", "TIMEWEB_TOKEN",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET",
    "MAX_BOT_TOKEN", "CRON_SECRET", "GITHUB_TOKEN",
    "BLOCKIFY_API_KEY", "BRIGHTDATA_API_TOKEN",
}

# Parse .env.local (skip comments and empty lines)
envs = []
for line in env_file.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    if "=" not in line:
        continue
    key, _, value = line.partition("=")
    key = key.strip()
    value = value.strip().strip('"').strip("'")
    if not key:
        continue
    envs.append({
        "name": key,
        "value": value,
        "is_secret": key in SECRET_KEYS,
    })

print(f"Found {len(envs)} variables in {env_file}")
print(f"Sending to app {APP_ID}...")

payload = json.dumps({"envs": envs})
result = subprocess.run(
    ["curl", "-s", "-w", "\nHTTP:%{http_code}", "-X", "PUT",
     "-H", f"Authorization: Bearer {TOKEN}",
     "-H", "Content-Type: application/json",
     "-d", payload,
     f"{BASE}/apps/{APP_ID}/envs"],
    capture_output=True, text=True
)

output = result.stdout
if "HTTP:200" in output or "HTTP:201" in output:
    print("SUCCESS: variables set")
    print("Triggering redeploy...")
    r2 = subprocess.run(
        ["curl", "-s", "-w", "\nHTTP:%{http_code}", "-X", "POST",
         "-H", f"Authorization: Bearer {TOKEN}",
         f"{BASE}/apps/{APP_ID}/deploy"],
        capture_output=True, text=True
    )
    if "HTTP:200" in r2.stdout or "HTTP:201" in r2.stdout:
        print("REDEPLOY triggered")
    else:
        print("Redeploy response:", r2.stdout[-200:])
else:
    print("FAILED:", output[-300:])
    sys.exit(1)
