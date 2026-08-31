# retexture-service — Python (FastAPI) 3D bake service for Cloud Run.
#
# Unlike the NestJS services (Dockerfile.template), this is Python: the geometry
# core (trimesh / scipy / rembg / onnxruntime) is scientific Python. Cloud Run
# sets $PORT; the bake is CPU-heavy and slow, so deploy with generous memory,
# CPU, timeout and concurrency=1 (see docs/deployment-plan.md).
#
# Build context is the SERVICE directory (apps/retexture-service), NOT the repo
# root — this service has no workspace deps. The build-push script passes
# `apps/retexture-service` as the context when a per-service Dockerfile exists.

FROM python:3.12-slim AS base

# System libs the wheels need at runtime:
#   libgomp1        — onnxruntime OpenMP runtime
#   libgl1 / libglib2.0-0 — image libs pulled by pillow/scikit-image/pymatting
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgomp1 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user; HOME is writable so rembg can cache its model.
RUN useradd --create-home --uid 1001 appuser
ENV HOME=/home/appuser \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install Python deps first (layer cache: only re-runs when requirements change).
COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

# Pre-download the rembg background-removal model so a cold start doesn't stall
# fetching it on the first request. Cached under $HOME/.u2net.
RUN mkdir -p ${HOME}/.u2net && chown -R appuser:appuser ${HOME} \
    && python -c "from rembg import new_session; new_session('u2net')" || true

# App code + vendored geometry (prep / render_views / retexture).
COPY app ./app
COPY py ./py
RUN chown -R appuser:appuser /app

USER appuser

# Cloud Run injects PORT (default 8080). /health is the readiness endpoint.
EXPOSE 8080
CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
