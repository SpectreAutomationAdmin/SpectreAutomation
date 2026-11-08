"""EP-TRAIN-4Y-E — Deployable Modal App for spectre.training.generate.v1.

Contract: 4yb-v1 Hybrid authentication (symmetric to the transcribe
endpoint — see transcribe_app.py header).

Model: Qwen 2.5 7B Instruct AWQ (preserves EP-TRAIN-6C-11's validated
choice; see `modal app info spectre-training-generate` — 2026-11-04
v1 used A10G).
GPU: A10G. 7B-AWQ quantization fits in A10G's 24GB vRAM with headroom
for LM Format Enforcer's structured decoding.
Weights volume: spectre-qwen-weights-cache (created on first deploy).

Deployment:
    modal deploy modal_endpoints/generate_app.py
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import modal

from .spectre_training_generate import _handle_generate_request
from .shared.replay import ModalDictReplayRegistry


# ───────────────────────────────────────────────────────── Modal App

app = modal.App("spectre-training-generate")

# Image — CUDA 12.1 + PyTorch + transformers + AWQ + LM Format
# Enforcer. Versions pinned for reproducible deploys. The exact set
# tracks EP-TRAIN-6C-11's validated pip_freeze.
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("git")
    .pip_install(
        # EP-TRAIN-4Y-M (2026-11-08) — explicit pins to resolve the
        # autoawq/transformers drift surfaced in 4Y-L. `autoawq==0.2.6`
        # imports `transformers.modeling_utils.shard_checkpoint`, which
        # was removed in transformers 4.47. Pin transformers to the last
        # 4.46.x release (contains `shard_checkpoint`). torch stays at
        # 2.3.1 per autoawq 0.2.6's hard dependency pin. accelerate +
        # huggingface-hub upper-bounded to their 4.46-era compatibles.
        "torch==2.3.1",
        "transformers==4.46.3",
        "autoawq==0.2.6",
        "accelerate>=0.33,<1.0",
        "huggingface-hub>=0.24,<0.27",
        "lm-format-enforcer>=0.10,<0.11",
        "fastapi>=0.110",
        "pydantic>=2",
    )
)

# Volumes & stores.
qwen_weights_volume = modal.Volume.from_name(
    "spectre-qwen-weights-cache", create_if_missing=True
)
# Shared replay-registry Dict (same name as transcribe app — cross-app
# atomic put-if-absent on the composite key authorizationId:requestId).
replay_dict = modal.Dict.from_name(
    "spectre-training-replay-4yb-v1", create_if_missing=True
)

secrets = [
    modal.Secret.from_name("spectre-training-runtime-hmac"),
    modal.Secret.from_name("spectre-training-pilot-fingerprint-secret"),
    modal.Secret.from_name("spectre-training-response-hmac-key"),
]

# Qwen 2.5 7B Instruct AWQ — HF repo + revision pin.
QWEN_REPO = "Qwen/Qwen2.5-7B-Instruct-AWQ"


# ───────────────────────────────────────── GPU container (Qwen)

@app.cls(
    image=image,
    gpu="A10G",
    volumes={"/weights": qwen_weights_volume},
    secrets=secrets,
    timeout=900,            # 15 min max per generation call
    scaledown_window=180,   # 3 min idle → scale to zero
    max_containers=1,       # protect $10 spend cap
)
class Qwen:
    @modal.enter()
    def _load_model(self) -> None:
        """Load Qwen 2.5 7B AWQ from the persistent volume. First
        container boot downloads ~5GB; subsequent boots are instant-
        cached."""
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(
            QWEN_REPO,
            cache_dir="/weights",
        )
        self.model = AutoModelForCausalLM.from_pretrained(
            QWEN_REPO,
            cache_dir="/weights",
            device_map="cuda:0",
            torch_dtype="auto",
        )
        self.model.eval()

    @modal.method()
    def generate(
        self,
        *,
        system_prompt: str,
        transcript: str,
        constraints: dict,
    ) -> dict:
        """Run Qwen inference with LM Format Enforcer structured
        decoding. Returns proposals + elapsedMs + tokenCounts.

        ENV-GATED: refuses to run when SPECTRE_GATE_1_NO_INFERENCE=1.
        """
        if os.environ.get("SPECTRE_GATE_1_NO_INFERENCE") == "1":
            raise RuntimeError("SPECTRE_GATE_1_NO_INFERENCE=1 — inference blocked")

        import torch
        from lmformatenforcer import JsonSchemaParser
        from lmformatenforcer.integrations.transformers import (
            build_transformers_prefix_allowed_tokens_fn,
        )

        max_q = int(constraints.get("maxQuestions", 1))
        allowed_types = list(constraints.get("allowedQuestionTypes", ["SINGLE_CHOICE"]))

        # JSON schema for a batch of proposals. Enforced by LMFE so
        # the model cannot emit malformed JSON.
        schema = {
            "type": "object",
            "properties": {
                "proposals": {
                    "type": "array",
                    "maxItems": max_q,
                    "items": {
                        "type": "object",
                        "properties": {
                            "questionType": {"type": "string", "enum": allowed_types},
                            "questionText": {"type": "string"},
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "text": {"type": "string"},
                                        "isCorrect": {"type": "boolean"},
                                    },
                                    "required": ["text", "isCorrect"],
                                },
                            },
                            "explanation": {"type": "string"},
                            "sourceSegmentIds": {
                                "type": "array",
                                "items": {"type": "integer"},
                            },
                        },
                        "required": [
                            "questionType",
                            "questionText",
                            "options",
                            "explanation",
                            "sourceSegmentIds",
                        ],
                    },
                }
            },
            "required": ["proposals"],
        }

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Transcript:\n{transcript}"},
        ]
        prompt_text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self.tokenizer(prompt_text, return_tensors="pt").to(self.model.device)
        prompt_token_count = inputs["input_ids"].shape[1]

        parser = JsonSchemaParser(schema)
        allowed_fn = build_transformers_prefix_allowed_tokens_fn(self.tokenizer, parser)

        t0 = time.time()
        with torch.inference_mode():
            output_ids = self.model.generate(
                **inputs,
                max_new_tokens=2048,
                do_sample=False,
                prefix_allowed_tokens_fn=allowed_fn,
                pad_token_id=self.tokenizer.eos_token_id,
            )
        elapsed_ms = int((time.time() - t0) * 1000)

        new_ids = output_ids[0, prompt_token_count:]
        output_text = self.tokenizer.decode(new_ids, skip_special_tokens=True)
        output_token_count = int(new_ids.shape[0])

        try:
            parsed = json.loads(output_text)
            proposals = parsed.get("proposals", [])
        except json.JSONDecodeError:
            # LMFE should prevent this; defensive.
            proposals = []

        return {
            "proposals": proposals,
            "elapsedMs": {"coldBoot": 0, "generate": elapsed_ms},
            "tokenCounts": {
                "prompt": prompt_token_count,
                "output": output_token_count,
            },
        }


# ───────────────────────────────────────── CPU HTTP endpoint

@app.function(
    image=image,
    secrets=secrets,
    timeout=120,
    # EP-TRAIN-4Y-L (2026-11-08) §4 — Gate 2 activation for Qwen.
    # The `env={"SPECTRE_GATE_1_NO_INFERENCE": "1"}` line was removed
    # under one authorized pilot. The CPU-boundary guard (`_run_qwen`
    # check) still works if the env var is ever re-set externally — set
    # `SPECTRE_GATE_1_NO_INFERENCE=1` via `modal secret create` + redeploy
    # to re-enter Gate 1 mode without a code change. Matches the
    # 2026-11-07 transcribe_app.py Gate 2 activation.
)
@modal.asgi_app()
def api():
    """CPU ASGI endpoint. Verifies HMAC + fingerprint + replay BEFORE
    any GPU call. Attacker-controlled requests fail authentication
    and NEVER reach the GPU container. SPECTRE_GATE_1_NO_INFERENCE=1
    causes `_run_qwen` to raise ContractError(REQUEST_BODY_INVALID,
    http_status=503) at the CPU boundary — zero GPU time."""
    # Starlette primitives — see transcribe_app.py for the FastAPI
    # 0.162+ parameter-introspection bug this sidesteps.
    from starlette.applications import Starlette
    from starlette.requests import Request as _Request
    from starlette.responses import Response
    from starlette.routing import Route

    from .shared.errors import ContractError, FailureCode

    qwen = Qwen()  # type: ignore[call-arg]

    async def generate_endpoint(request: _Request) -> Response:
        body_text = (await request.body()).decode("utf-8")
        headers = {k.lower(): v for k, v in request.headers.items()}

        def _run_qwen(system_prompt: str, transcript: str, constraints: dict):
            # §3 CPU-BOUNDARY GATE — checked BEFORE any .remote() call.
            if os.environ.get("SPECTRE_GATE_1_NO_INFERENCE") == "1":
                raise ContractError(
                    FailureCode.REQUEST_BODY_INVALID,
                    "SPECTRE_GATE_1_NO_INFERENCE=1 — CPU gate refused inference (Gate 1 diagnostic path)",
                    http_status=503,
                )
            result = qwen.generate.remote(
                system_prompt=system_prompt,
                transcript=transcript,
                constraints=constraints,
            )
            return result["proposals"], result["elapsedMs"], result["tokenCounts"]

        http_status, resp_body, resp_hdrs = _handle_generate_request(
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
            run_qwen=_run_qwen,
        )
        return Response(
            content=resp_body,
            status_code=http_status,
            headers=resp_hdrs,
        )

    web = Starlette(routes=[Route("/", generate_endpoint, methods=["POST"])])
    return web


__all__ = ["app", "Qwen", "api"]
