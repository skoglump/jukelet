UV ?= uv
PYTHON ?= python3

.PHONY: bootstrap check backend-check frontend-check build backend-build frontend-build image smoke

bootstrap:
	$(UV) sync --project backend --locked
	npm --prefix frontend ci

check: backend-check frontend-check

backend-check:
	$(UV) run --project backend --locked ruff check --config backend/pyproject.toml backend scripts
	$(UV) run --project backend --locked ruff format --check --config backend/pyproject.toml backend scripts
	$(UV) run --project backend --locked mypy --config-file backend/pyproject.toml backend/src backend/tests
	$(UV) run --project backend --locked pytest backend/tests

frontend-check:
	npm --prefix frontend run lint
	npm --prefix frontend run typecheck
	npm --prefix frontend test

build: backend-build frontend-build

backend-build:
	$(UV) build --project backend

frontend-build:
	npm --prefix frontend run build

image:
	docker compose -f compose.yaml -f compose.dev.yaml build

smoke:
	$(PYTHON) scripts/smoke.py --browser
