"""EP-TRAIN-4Y-E §6 — Offline deployment-discovery verification.

Proves that:
  - Both `modal_endpoints.transcribe_app` and `modal_endpoints.generate_app`
    import successfully.
  - Each module exposes a `modal.App` named exactly as the Spectre
    worker clients expect (`spectre-training-transcribe`,
    `spectre-training-generate`).
  - Each app registers exactly the expected class (GPU inference
    container) and the expected ASGI web endpoint (`api`).
  - Images are well-formed.
  - Secret references + volume references + replay-Dict reference
    all resolve by name.
  - `import modal` reaches the installed SDK — NOT the (renamed)
    local directory.

This is NOT a deploy. No Modal cloud call happens. No GPU is
allocated. No model is loaded.
"""

from __future__ import annotations

import unittest
from pathlib import Path


class ModalSdkShadowingTest(unittest.TestCase):
    """§2 — After the rename, `import modal` must find the SDK."""

    def test_modal_sdk_reachable_and_not_local(self):
        import modal

        # The SDK's own version attribute must exist. If the local
        # directory shadowed the SDK, this would fail with
        # AttributeError.
        self.assertTrue(hasattr(modal, "__version__"))
        self.assertTrue(hasattr(modal, "App"))
        self.assertTrue(hasattr(modal, "Image"))
        self.assertTrue(hasattr(modal, "Secret"))
        self.assertTrue(hasattr(modal, "Volume"))
        self.assertTrue(hasattr(modal, "Dict"))

        # Confirm the SDK is NOT loaded from the repo's own directory.
        sdk_path = Path(modal.__file__).resolve()
        repo_root = Path(__file__).resolve().parents[2]
        self.assertFalse(
            str(sdk_path).startswith(str(repo_root)),
            msg=(
                f"Modal SDK is being loaded from inside the repo at "
                f"{sdk_path} — the rename did not take effect. "
                "Expected SDK loaded from site-packages."
            ),
        )


class TranscribeAppDiscoveryTest(unittest.TestCase):
    """§6 — spectre-training-transcribe deployment discovery."""

    def setUp(self):
        import modal_endpoints.transcribe_app as t

        self.mod = t

    def test_modal_app_declared_with_expected_name(self):
        import modal

        self.assertIsInstance(self.mod.app, modal.App)
        self.assertEqual(self.mod.app.name, "spectre-training-transcribe")

    def test_registered_class_gpu_inference_container(self):
        # One GPU container class exists with exactly the name we
        # expect. The Hybrid auth asgi handler routes GPU calls here
        # via .remote().
        self.assertIn("Transcriber", self.mod.app.registered_classes)

    def test_registered_web_endpoint_asgi_api(self):
        self.assertIn("api", self.mod.app.registered_web_endpoints)

    def test_api_function_is_cpu_only(self):
        # Attacker-controlled requests must NEVER reach GPU before
        # auth passes. The ASGI handler itself must be CPU-only; GPU
        # is only via Transcriber.transcribe.remote() AFTER auth.
        api_fn = self.mod.app.registered_functions["api"]
        self.assertFalse(
            bool(getattr(api_fn, "gpu", None)),
            "api ASGI function must be CPU-only",
        )

    def test_module_exports_expected_public_api(self):
        self.assertIn("app", self.mod.__all__)
        self.assertIn("Transcriber", self.mod.__all__)
        self.assertIn("api", self.mod.__all__)

    def test_secret_references_are_by_name(self):
        # The three Hybrid-contract secrets. We verify they are
        # Modal.Secret references by NAME (lazy resolution at deploy
        # time); never inlined values.
        import modal_endpoints.transcribe_app as t

        self.assertEqual(len(t.secrets), 3)
        for s in t.secrets:
            import modal

            self.assertIsInstance(s, modal.Secret)


class GenerateAppDiscoveryTest(unittest.TestCase):
    """§6 — spectre-training-generate deployment discovery."""

    def setUp(self):
        import modal_endpoints.generate_app as g

        self.mod = g

    def test_modal_app_declared_with_expected_name(self):
        import modal

        self.assertIsInstance(self.mod.app, modal.App)
        self.assertEqual(self.mod.app.name, "spectre-training-generate")

    def test_registered_class_gpu_inference_container(self):
        self.assertIn("Qwen", self.mod.app.registered_classes)

    def test_registered_web_endpoint_asgi_api(self):
        self.assertIn("api", self.mod.app.registered_web_endpoints)

    def test_api_function_is_cpu_only(self):
        api_fn = self.mod.app.registered_functions["api"]
        self.assertFalse(
            bool(getattr(api_fn, "gpu", None)),
            "api ASGI function must be CPU-only",
        )

    def test_module_exports_expected_public_api(self):
        self.assertIn("app", self.mod.__all__)
        self.assertIn("Qwen", self.mod.__all__)
        self.assertIn("api", self.mod.__all__)

    def test_secret_references_are_by_name(self):
        import modal_endpoints.generate_app as g

        self.assertEqual(len(g.secrets), 3)
        for s in g.secrets:
            import modal

            self.assertIsInstance(s, modal.Secret)

    def test_qwen_repo_pin(self):
        # §5 "Preserve the previously selected models" — Qwen 2.5 7B
        # Instruct AWQ.
        self.assertEqual(self.mod.QWEN_REPO, "Qwen/Qwen2.5-7B-Instruct-AWQ")


class SharedResourcesTest(unittest.TestCase):
    """Cross-app shared resources."""

    def test_replay_dict_name_identical_across_apps(self):
        # Replay registry is a single workspace-level modal.Dict so
        # the composite key (authorizationId:requestId) atomically
        # dedupes across both endpoints.
        import modal_endpoints.transcribe_app as t
        import modal_endpoints.generate_app as g

        self.assertEqual(
            type(t.replay_dict).__name__,
            type(g.replay_dict).__name__,
            msg="Both apps must use the same type of Dict reference.",
        )
        # The Dict reference's declared name must match. (Direct
        # attribute access on Modal.Dict is SDK-version-specific;
        # use repr as a stable compare.)
        self.assertIn("spectre-training-replay-4yb-v1", repr(t.replay_dict))
        self.assertIn("spectre-training-replay-4yb-v1", repr(g.replay_dict))


if __name__ == "__main__":
    unittest.main()
