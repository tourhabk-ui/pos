#!/usr/bin/env python3
"""Читалка страниц-источников для летописи (docs/chronicle/AGENT_PROMPT.md).

Из контейнера агента внешний интернет закрыт, раннер GitHub ходит свободно.
Скрипт берёт адреса из docs/chronicle/drafts/.fetch.json, скачивает каждую
страницу и печатает её ТЕКСТ в лог и в /tmp/chronicle/NN.txt — чтобы факты
статьи брались из прочитанной страницы, а не из поисковой выдачи.

Для статей Википедии печатаются два слоя: чистый текст (API extracts) и
строки вики-разметки с пометками «нет источника» / «нет АИ» / citation needed —
правило промпта §2: факт с такой пометкой брать нельзя, а в чистом тексте
пометка не видна. Ничего не пишет ни в БД, ни в репозиторий.
"""
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request

MARKER = 'docs/chronicle/drafts/.fetch.json'
OUT_DIR = '/tmp/chronicle'
UA = 'Mozilla/5.0 (X11; Linux x86_64) VedarChronicleReader/1.0 (+https://vedarai.ru)'
TEXT_CAP = 70000
MARK_RE = re.compile(
    r'нет источника|нет АИ|нет ссылки|неавторитетный источник|citation needed|'
    r'\{\{cn\b|\{\{fact\b|уточнить|источник\?', re.IGNORECASE)
WIKI_RE = re.compile(r'^https?://([a-z]{2,3})\.wikipedia\.org/wiki/(.+)$')


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def html_to_text(raw):
    s = raw.decode('utf-8', errors='replace')
    s = re.sub(r'(?is)<(script|style|noscript|svg|nav|footer|header)\b.*?</\1>', ' ', s)
    s = re.sub(r'(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr|table|blockquote|section|article)>', '\n', s)
    s = re.sub(r'(?s)<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'[ \t\xa0]+', ' ', s)
    s = re.sub(r'\n\s*\n+', '\n', s)
    return s.strip()


def wiki(lang, title):
    api = f'https://{lang}.wikipedia.org/w/api.php?'
    title = urllib.parse.unquote(title).replace('_', ' ')
    q = urllib.parse.urlencode({
        'action': 'query', 'prop': 'extracts|revisions', 'explaintext': 1, 'redirects': 1,
        'rvprop': 'content|timestamp', 'rvslots': 'main', 'format': 'json',
        'formatversion': 2, 'utf8': 1, 'titles': title,
    })
    status, body = get(api + q)
    data = json.loads(body)
    page = data['query']['pages'][0]
    if page.get('missing'):
        return f'(статьи «{title}» в {lang}.wikipedia нет)'
    out = [f"# {page['title']} ({lang}.wikipedia)"]
    rev = (page.get('revisions') or [{}])[0]
    out.append(f"версия от {rev.get('timestamp', '?')}")
    extract = page.get('extract', '')
    out.append('')
    out.append('## ТЕКСТ')
    out.append(extract[:TEXT_CAP])
    if len(extract) > TEXT_CAP:
        out.append(f'…ОБРЕЗАНО: показано {TEXT_CAP} из {len(extract)} знаков')
    wikitext = (rev.get('slots') or {}).get('main', {}).get('content', '')
    marks = [ln.strip()[:400] for ln in wikitext.split('\n') if MARK_RE.search(ln)]
    out.append('')
    out.append(f'## ПОМЕТКИ В РАЗМЕТКЕ (строк: {len(marks)})')
    out.extend(marks[:80])
    return '\n'.join(out)


def main():
    cfg = json.load(open(MARKER, encoding='utf-8'))
    urls = cfg.get('urls', [])
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"Партия {cfg.get('batch', '?')}: {len(urls)} адресов. {cfg.get('why', '')}")
    failed = 0
    for i, url in enumerate(urls, 1):
        print('\n' + '═' * 60)
        print(f'[{i}] {url}')
        try:
            m = WIKI_RE.match(url)
            if m:
                text = wiki(m.group(1), m.group(2))
            else:
                status, raw = get(url)
                text = f'HTTP {status}, байт {len(raw)}\n' + html_to_text(raw)[:TEXT_CAP]
        except Exception as e:  # noqa: BLE001 — причина печатается, не глушится
            failed += 1
            text = f'НЕ ПРОЧИТАНО: {type(e).__name__}: {e}'
        print(text)
        with open(f'{OUT_DIR}/{i:02d}.txt', 'w', encoding='utf-8') as f:
            f.write(f'{url}\n\n{text}\n')
    print('\n' + '═' * 60)
    print(f'Итого: {len(urls)} адресов, не прочитано {failed}')
    sys.exit(1 if failed == len(urls) and urls else 0)


if __name__ == '__main__':
    main()
