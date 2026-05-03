# Tusk Ledger — public demo deployment image.
#
# This image is shaped for the demo.tuskledger.com use case (DEMO_LOCKED=true,
# read-only, synthetic data, no Plaid). It also runs perfectly fine as a
# normal local image — DEMO_LOCKED defaults to false, so without that env
# var set the container behaves like a normal local install.
#
# Two-stage build:
#   1. node:22 to build the React bundle (frontend/dist)
#   2. python:3.12-slim to install backend deps and seed the demo SQLite
#      DB at build time, then serve the whole thing on $PORT.
#
# The demo DB is seeded at BUILD time, not at runtime, so:
#   - cold starts are fast (no seeding work)
#   - every redeploy gets a freshly anchored demo (transactions are
#     re-dated relative to "today" each time the image is rebuilt)
#   - the seed script doesn't need to be in the runtime image's PATH

# ─── Stage 1: build the frontend ──────────────────────────────────
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
# Copy lockfile first for cache friendliness.
# Using `npm install` rather than `npm ci` because the lockfile in the
# repo can drift from package.json (Dependabot bumps land sequentially
# and the lock occasionally lags). `npm install` resolves the diff;
# `npm ci` would fail hard. Demo deploy doesn't need lockfile-strict
# reproducibility — a normal local install can still use `npm ci`.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ .
# vite build emits to frontend/dist, which the Python stage copies in
RUN npm run build

# ─── Stage 2: backend + seeded demo DB ────────────────────────────
FROM python:3.12-slim AS runtime
WORKDIR /app

# Build deps for any wheels that might need compiling (e.g. cryptography).
# Slim image lacks gcc by default; install + remove in one layer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps. Copying requirements first for cache friendliness.
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# Application code
COPY backend/ /app/backend/

# Built frontend bundle from stage 1
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# Seed the demo DB at build time so cold starts don't pay the cost.
# We deliberately set DEMO_LOCKED here too so any side-effect imports
# during the seed run see the same config the runtime will.
ENV DEMO_LOCKED=true
WORKDIR /app/backend
RUN python -m app.scripts.seed_demo --output ./tuskledger_demo.db
WORKDIR /app

# Strip the build-only apt packages to shrink the final image. The wheels
# are already installed; we don't need gcc anymore.
RUN apt-get purge -y --auto-remove build-essential libffi-dev || true

# Healthcheck-friendly env. Railway maps $PORT into the container.
ENV PYTHONUNBUFFERED=1
ENV HOST=0.0.0.0
EXPOSE 8000

# Start command: uvicorn binds to whatever port Railway assigns. The
# DEMO_LOCKED banner will print at startup so the operator can confirm
# the lockdown is active in logs.
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
