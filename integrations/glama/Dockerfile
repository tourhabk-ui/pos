# Повтор образа, который Glama собирает по форме сервера tourhabk-ui/pos.
# Значения формы — glama-build.json, пояснение — README.md рядом.
#
# Glama собирает сервер из репозитория и мост к vedarai.ru не принимает
# (20.11). Образ запускает integrations/glama/server/server.mjs: сервер stdio
# без зависимостей и без базы. Он отдаёт настоящие определения инструментов
# Ведара, а вызов честно отвечает, что данных в этой сборке нет, и называет
# живой сервер. Запросов наружу образ не делает.
#
# Glama сама ставит основу (debian:trixie-slim, Node 24) и mcp-proxy, кладёт
# репозиторий и исполняет шаги сборки и CMD формы из его корня. Этот файл
# повторяет это, чтобы проверить сборку локально (из корня репозитория):
#   docker build -f integrations/glama/Dockerfile -t vedar-glama .
#   docker run --rm -p 8080:8080 vedar-glama
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g mcp-proxy@6.9.0

WORKDIR /app
COPY integrations/glama/server ./integrations/glama/server

# Шаг сборки формы Glama.
RUN node integrations/glama/server/server.mjs --self-check

# mcp-proxy слушает 8080; Glama префиксует CMD формы словами «mcp-proxy --».
CMD ["mcp-proxy", "--", "node", "integrations/glama/server/server.mjs"]
