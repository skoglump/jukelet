UV ?= uv
PYTHON ?= python3

.PHONY: bootstrap check backend-check frontend-check build backend-build frontend-build image smoke companion-check integration-package

bootstrap:
	$(UV) sync --project backend --locked
	npm --prefix frontend ci

check: backend-check frontend-check

backend-check: companion-check
	$(UV) run --project backend --locked ruff check --config backend/pyproject.toml backend scripts spikes companion
	$(UV) run --project backend --locked ruff format --check --config backend/pyproject.toml backend scripts spikes companion
	$(UV) run --project backend --locked mypy --config-file backend/pyproject.toml backend/src backend/tests
	$(UV) run --project backend --locked pytest backend/tests

# HA-independent companion and historical spike contracts run in ordinary CI; actual HA is opt-in.
companion-check:
	$(UV) run --project backend --locked mypy --config-file backend/pyproject.toml --explicit-package-bases --follow-imports=skip spikes/ha_companion/custom_components/jukelet_bridge/protocol.py spikes/ha_companion/custom_components/jukelet_bridge/bridge.py spikes/ha_companion/tests companion/custom_components/jukelet_bridge/protocol.py companion/custom_components/jukelet_bridge/bridge.py companion/custom_components/jukelet_bridge/playback.py companion/custom_components/jukelet_bridge/dispatcher.py companion/custom_components/jukelet_bridge/administration.py companion/custom_components/jukelet_bridge/compatibility.py companion/tests
	$(PYTHON) -m unittest discover -s spikes/ha_companion/tests -v
	$(PYTHON) -m unittest discover -s companion/tests -v

frontend-check:
	npm --prefix frontend run lint
	npm --prefix frontend run typecheck
	npm --prefix frontend test

integration-package:
	$(PYTHON) scripts/package_integration.py --ref HEAD --output dist/integration

# Build uses committed source, never the working directory or deployment configuration.
build: backend-build frontend-build

backend-build:
	$(UV) build --project backend

frontend-build:
	npm --prefix frontend run build

image:
	docker compose -f compose.yaml -f compose.dev.yaml build

smoke:
	$(PYTHON) scripts/smoke.py --browser
