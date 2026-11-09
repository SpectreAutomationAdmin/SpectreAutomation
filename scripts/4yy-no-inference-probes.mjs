// EP-TRAIN-4Y-Y §3 — no-inference probes for the new /metadata route.
//
// Every probe targets the AUTH boundary of the new metadata endpoint
// so no probe causes a GPU container to spin up. The Qwen container
// only starts after the CPU-side verify_request_envelope passes AND
// the signed pilot authorization is accepted AND the replay check
// succeeds — none of our probes satisfy all three.
//
// Probes:
//   1. Endpoint availability — POST / 400 or 401 reply + Starlette
//      is routing the path (not 404).
//   2. Authentication enforcement — unsigned request → 400/401 with
//      a signed error body or empty body.
//   3. Request validation — malformed JSON → 400.
//   4. Operation routing — correct operation in envelope → envelope
//      verify tripped on signature.
//   5. Invalid operation handling — wrong operation name → rejected.
//   6. Signed error responses — error body carries X-Spectre-* headers
//      when the envelope got far enough to sign.
//   7. Existing /generate route still responds (back-compat).
//
// No real valid pilot authorization is minted. No valid HMAC signature
// is sent. Zero GPU time billed.

const BASE = "https://spectreautomation-admin--spectre-training-generate-api.us-east.modal.run";
const GENERATE_URL = BASE;
const METADATA_URL = `${BASE}/metadata`;

async function probe(label, url, init = {}) {
  const t0 = Date.now();
  let status, bodyText, respHeaders;
  try {
    const r = await fetch(url, init);
    status = r.status;
    bodyText = await r.text();
    respHeaders = {};
    r.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
  } catch (err) {
    console.log(`  ${label}: ERROR ${err.message}`);
    return;
  }
  const ms = Date.now() - t0;
  // Redact any Modal-* header values; keep only the names + Spectre-*
  // headers which are safe (they carry request-id, operation, status,
  // but not keys).
  const safeHeaders = Object.fromEntries(
    Object.entries(respHeaders).filter(([k]) =>
      k.startsWith("x-spectre-") || k === "content-type" || k === "modal-call-id",
    ),
  );
  const bodyPreview = bodyText.slice(0, 300);
  console.log(`  ${label}: HTTP ${status} in ${ms}ms`);
  console.log(`    headers: ${JSON.stringify(safeHeaders)}`);
  console.log(`    body: ${bodyPreview}`);
}

async function main() {
  console.log("--- Probe 1: Endpoint availability (POST /metadata with bare empty body) ---");
  await probe("empty-body-metadata", METADATA_URL, {
    method: "POST",
    body: "",
  });

  console.log("\n--- Probe 2: Auth enforcement (POST /metadata with JSON but no signing headers) ---");
  await probe("no-signing-metadata", METADATA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contractVersion: "4yb-v1", operation: "spectre.training.metadata.v1", requestId: "probe-no-sig" }),
  });

  console.log("\n--- Probe 3: Request validation (POST /metadata with malformed JSON) ---");
  await probe("malformed-body-metadata", METADATA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-spectre-sig-version": "v1",
      "x-spectre-operation": "spectre.training.metadata.v1",
      "x-spectre-request-id": "probe-malformed",
      "x-spectre-timestamp": `${Math.floor(Date.now() / 1000)}`,
      "x-spectre-body-digest": "deadbeef",
      "x-spectre-signature": "deadbeef-not-a-real-sig",
      "x-spectre-contract-version": "4yb-v1",
    },
    body: "{not json",
  });

  console.log("\n--- Probe 4: Operation routing (POST /metadata with wrong operation in envelope) ---");
  await probe("wrong-op-metadata", METADATA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-spectre-sig-version": "v1",
      "x-spectre-operation": "spectre.training.generate.v1",
      "x-spectre-request-id": "probe-wrong-op",
      "x-spectre-timestamp": `${Math.floor(Date.now() / 1000)}`,
      "x-spectre-body-digest": "deadbeef",
      "x-spectre-signature": "deadbeef",
      "x-spectre-contract-version": "4yb-v1",
    },
    body: JSON.stringify({ contractVersion: "4yb-v1", operation: "spectre.training.generate.v1" }),
  });

  console.log("\n--- Probe 5: Invalid operation handling (POST /metadata with unknown operation) ---");
  await probe("unknown-op-metadata", METADATA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-spectre-sig-version": "v1",
      "x-spectre-operation": "spectre.training.unknown.v1",
      "x-spectre-request-id": "probe-unknown",
      "x-spectre-timestamp": `${Math.floor(Date.now() / 1000)}`,
      "x-spectre-body-digest": "deadbeef",
      "x-spectre-signature": "deadbeef",
      "x-spectre-contract-version": "4yb-v1",
    },
    body: JSON.stringify({ contractVersion: "4yb-v1", operation: "spectre.training.unknown.v1" }),
  });

  console.log("\n--- Probe 7: Existing /generate route still responds (back-compat) ---");
  await probe("generate-root", GENERATE_URL, {
    method: "POST",
    body: "",
  });
}

main().catch((err) => {
  console.error("FATAL:", err?.stack ?? err);
  process.exit(1);
});
