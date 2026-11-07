"""EP-TRAIN-4Y-E — Deployable Modal App for spectre.training.transcribe.v1.

Contract: 4yb-v1 Hybrid authentication (request HMAC + PilotAuthorizationV1
fingerprint + response HMAC + atomic replay via modal.Dict.put(..., skip_if_exists=True)).

Model: faster-whisper large-v3 (per EP-TRAIN-6C-11 architecture).
GPU: A10G (matches 6C-11 deployment history; see modal app info
spectre-training-transcribe — 2026-11-02 v1 was A10G).
Weights volume: spectre-whisper-weights-cache (pre-existing from 6C-11).

Deployment:
    modal deploy modal_endpoints/transcribe_app.py

This module imports the Hybrid-auth helpers from the same package
(._handle_transcribe_request, shared.replay.ModalDictReplayRegistry,
etc.) and wires them into:
  - `Transcriber` class — GPU container with Whisper preloaded via
    @modal.enter(); @modal.method() transcribe(wav_bytes).
  - `api` function — CPU ASGI handler that performs ALL auth / replay
    / response-signing on CPU before delegating to Transcriber via
    .remote(). Attacker-controlled requests NEVER reach GPU.

Cost / concurrency / cold-start documented in
PHASE-4Y-E-DEPLOYMENT-RUNBOOK.md §3.
"""

from __future__ import annotations

import io
import os
import time
import urllib.request
from typing import Any

import modal

from .spectre_training_transcribe import _handle_transcribe_request
from .shared.replay import ModalDictReplayRegistry


# ───────────────────────────────────────────────────────── Modal App

app = modal.App("spectre-training-transcribe")

# Image — CUDA 12.1 (compatible with ctranslate2 ≥ 4) + ffmpeg +
# faster-whisper. Pinned versions for reproducible deploys.
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install(
        "faster-whisper==1.0.3",
        "ctranslate2>=4.4.0,<5",
        "av>=12",
        "fastapi>=0.110",
        "huggingface-hub>=0.24",
    )
)

# Volumes & stores (names stable for operator reuse).
weights_volume = modal.Volume.from_name(
    "spectre-whisper-weights-cache", create_if_missing=True
)
replay_dict = modal.Dict.from_name(
    "spectre-training-replay-4yb-v1", create_if_missing=True
)

secrets = [
    modal.Secret.from_name("spectre-training-runtime-hmac"),
    modal.Secret.from_name("spectre-training-pilot-fingerprint-secret"),
    modal.Secret.from_name("spectre-training-response-hmac-key"),
]


# ───────────────────────────────────────── GPU container (Whisper)

@app.cls(
    image=image,
    gpu="A10G",
    volumes={"/weights": weights_volume},
    secrets=secrets,
    # §8 bounded inference — 30 min upper bound for a very long video
    # (far above the 642 s Silver Springs orientation).
    timeout=1800,
    # Scale-to-zero after 3 min idle to protect the $10 spend cap.
    scaledown_window=180,
    # Hard cap at 1 GPU container per workspace; prevents parallel GPU
    # spend. Can be raised by operator post-pilot if needed.
    max_containers=1,
)
class Transcriber:
    @modal.enter()
    def _load_model(self) -> None:
        """Called once per container on first invocation. Loads
        faster-whisper large-v3 from the persistent volume (first
        boot downloads ~3GB; subsequent boots are instant-cached)."""
        from faster_whisper import WhisperModel

        self.model = WhisperModel(
            "large-v3",
            device="cuda",
            compute_type="float16",
            download_root="/weights",
        )

    @modal.method()
    def transcribe(self, wav_bytes: bytes) -> dict:
        """Run Whisper inference on the given audio bytes. Returns a
        dict with segments and duration. ENV-GATED: refuses to run
        when SPECTRE_GATE_1_NO_INFERENCE=1 (safety net during Gate 1
        acceptance; Gate 2 operator removes the env var)."""
        if os.environ.get("SPECTRE_GATE_1_NO_INFERENCE") == "1":
            # Explicit refusal — not a fake output. Caller sees a
            # distinctive exception they can classify.
            raise RuntimeError("SPECTRE_GATE_1_NO_INFERENCE=1 — inference blocked")

        t0 = time.time()
        segments_iter, info = self.model.transcribe(
            io.BytesIO(wav_bytes),
            beam_size=5,
            language="en",
            vad_filter=True,
        )
        segments: list[dict] = []
        for i, seg in enumerate(segments_iter):
            # avg_logprob is in roughly (-1.0, 0.0); normalise to (0,1).
            conf = max(0.0, min(1.0, 1.0 + float(seg.avg_logprob)))
            segments.append(
                {
                    "id": i,
                    "startSec": float(seg.start),
                    "endSec": float(seg.end),
                    "text": seg.text.strip(),
                    "avgConfidence": conf,
                }
            )
        elapsed_ms = int((time.time() - t0) * 1000)
        return {
            "segments": segments,
            "elapsedMs": {"coldBoot": 0, "transcribe": elapsed_ms},
            "durationSec": int(info.duration),
        }


# ───────────────────────────────────────── CPU HTTP endpoint

def _download_audio(url: str) -> bytes:
    """Fetch the signed R2 URL. Hard 120-s timeout. Any failure is
    surfaced through the handler's `_signed_error` path."""
    with urllib.request.urlopen(url, timeout=120) as resp:
        return resp.read()


def _audio_passthrough(data: bytes) -> bytes:
    """faster-whisper accepts most formats via libav; no explicit
    wav conversion needed. The helper's `audio_to_wav` callable is a
    passthrough."""
    return data


@app.function(
    image=image,
    secrets=secrets,
    timeout=120,
    # EP-TRAIN-4Y-F §3 — Gate 1 default. Removing this env entry (and
    # redeploying) activates Gate 2 live inference. The ASGI handler
    # checks this env var BEFORE calling .remote(), so the GPU
    # container NEVER boots during Gate 1 — the no-inference gate is
    # enforced at the CPU boundary, not inside the GPU container.
    env={"SPECTRE_GATE_1_NO_INFERENCE": "1"},
)
@modal.asgi_app()
def api():
    """CPU ASGI endpoint. Performs HMAC + fingerprint + replay
    verification BEFORE any GPU call. On auth failure returns a
    signed error response immediately (no GPU container ever
    materialises). On auth success, delegates to Transcriber.
    transcribe.remote(...) which spins up (or reuses) the GPU
    container — UNLESS SPECTRE_GATE_1_NO_INFERENCE=1, in which case
    the helper's inference callable raises a signed ContractError
    before .remote() fires."""
    # Use Starlette primitives directly. FastAPI 0.162+ with
    # Starlette 1.10+ incorrectly treated a `Request`-typed param as
    # a query parameter, returning HTTP 422 "Field required" before
    # the handler body ever ran. A plain Starlette app sidesteps that
    # parameter-introspection path entirely.
    from starlette.applications import Starlette
    from starlette.requests import Request as _Request
    from starlette.responses import Response
    from starlette.routing import Route

    from .shared.errors import ContractError, FailureCode

    transcriber = Transcriber()  # type: ignore[call-arg]

    async def transcribe_endpoint(request: _Request) -> Response:
        body_text = (await request.body()).decode("utf-8")
        headers = {k.lower(): v for k, v in request.headers.items()}

        duration_holder: dict[str, int] = {"value": 0}

        def _run_whisper(wav_bytes: bytes) -> tuple[list[dict], dict]:
            # §3 CPU-BOUNDARY GATE — checked BEFORE any .remote() call.
            # When SPECTRE_GATE_1_NO_INFERENCE=1, we raise rather than
            # delegate; the helper catches the ContractError and emits
            # a signed error response. Zero GPU time, zero container
            # boot, no modal.enter() runs.
            if os.environ.get("SPECTRE_GATE_1_NO_INFERENCE") == "1":
                raise ContractError(
                    FailureCode.REQUEST_BODY_INVALID,
                    "SPECTRE_GATE_1_NO_INFERENCE=1 — CPU gate refused inference (Gate 1 diagnostic path)",
                    http_status=503,
                )
            result = transcriber.transcribe.remote(wav_bytes)
            duration_holder["value"] = int(result["durationSec"])
            return result["segments"], result["elapsedMs"]

        http_status, resp_body, resp_hdrs = _handle_transcribe_request(
            headers=headers,
            body_text=body_text,
            hmac_key=os.environ["MODAL_SPECTRE_HMAC_KEY"].encode("utf-8"),
            fingerprint_secret=os.environ[
                "SPECTRE_PILOT_AUTH_FINGERPRINT_SECRET"
            ].encode("utf-8"),
            response_hmac_key=(
                os.environ.get("MODAL_SPECTRE_RESPONSE_HMAC_KEY")
                or os.environ["MODAL_SPECTRE_HMAC_KEY"]
            ).encode("utf-8"),
            replay_registry=ModalDictReplayRegistry(replay_dict),
            now_sec=int(time.time()),
            download_audio=_download_audio,
            run_whisper=_run_whisper,
            audio_to_wav=_audio_passthrough,
            duration_sec=duration_holder["value"],
        )
        return Response(
            content=resp_body,
            status_code=http_status,
            headers=resp_hdrs,
        )

    web = Starlette(routes=[Route("/", transcribe_endpoint, methods=["POST"])])
    return web


__all__ = ["app", "Transcriber", "api"]
