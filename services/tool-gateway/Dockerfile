FROM python:3.13-alpine AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

FROM python:3.13-alpine
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY server.py factory.py ./
COPY tools/tools.py /tools/tools.py
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 TOOLS_PATH=/tools/tools.py PORT=8080
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["python", "/app/server.py"]
