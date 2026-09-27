# Spectre Payments — Canonical Rail Mapping

**Version:** 2026-09-26 (PAY-1C/2)
**Scope:** how Spectre's internal payment domain maps to a
provider-neutral canonical rail representation, and from there to
ISO 20022 concepts likely required by a future Canadian rail
adapter. This document does NOT claim ISO 20022 certification. Any
gap between Spectre's data and the actual ISO / rail specification
is called out below.

---

## 1. Layers

```
  ┌────────────────────────────────────────────────────────────┐
  │ 1. Economic instruction — PAY-1A domain (immutable)        │
  │    PaymentRun · PaymentInstruction · PaymentAuthorization  │
  └────────────────────────────────────────────────────────────┘
                             │  derive()
                             ▼
  ┌────────────────────────────────────────────────────────────┐
  │ 2. Canonical rail-neutral representation — PAY-1C          │
  │    CanonicalRailInstruction[]                              │
  │    (rail-facing, no bank secrets, deterministic E2E ID)    │
  └────────────────────────────────────────────────────────────┘
                             │  adapter.format()
                             ▼
  ┌────────────────────────────────────────────────────────────┐
  │ 3. Provider-specific transport                             │
  │    AFT file · ISO 20022 pain.001 · proprietary API body    │
  │    (concern of a future adapter — NOT built in PAY-1C)     │
  └────────────────────────────────────────────────────────────┘
```

The single source of economic truth is Layer 1. Layer 2 is a
projection. Layer 3 is per-adapter and outside PAY-1C.

## 2. Canonical rail-neutral representation

Defined at `src/lib/payments/rail/canonical.ts`:

```ts
interface CanonicalRailInstruction {
  spectrePaymentInstructionId: string;
  spectrePaymentRunId: string;
  clubId: string;
  amount: string;                    // Decimal-safe
  currency: string;
  requestedExecutionDate: string;    // ISO date, no timezone
  debtorFundingBankAccountId: string;
  debtorMaskedIdentifier: string;
  creditorDestinationSnapshotId: string;
  creditorMaskedIdentifier: string;
  creditorRecipientType: string;
  creditorRecipientId: string;
  endToEndId: string;                // deterministic E2E-v1-...
  remittance: CanonicalRemittance;
}
```

The end-to-end identifier is deterministic — same instruction, same
ID, forever. Retries do not produce a new ID; different payments
never collide.

## 3. End-to-end ID

Format: `E2E-v1-<32-char-hex>`.

Input to the hash (canonical JSON, in this exact order):

```
["E2E-v1", clubId, paymentRunId, paymentInstructionId,
 destinationSnapshotId, amount, currency, requestedExecutionDate]
```

Truncation to 32 hex chars (128 bits) is deliberate — long enough
for global uniqueness across Spectre's payment history, short
enough for readable transport strings. If a future institution's
end-to-end ID format constraints require shorter, the adapter
performs its own truncation with a documented mapping. If longer,
the adapter can carry the full 64-char SHA-256 in the E2E field
(no schema change).

## 4. Remittance information

Rail-neutral remittance carries what a rail needs to describe
"what is this payment for", without exposing SIN, unmasked bank
details, or credentials.

```ts
type CanonicalRemittance =
  | { purpose: "PAYROLL",
      payGroupCode: string | null,
      payPeriodReference: string | null,
      payDate: string | null,
      employeeSafeReference: string }    // NOT SIN
  | { purpose: "AP",
      invoiceNumbers: string[],
      vendorSafeReference: string }
  | { purpose: "REFUND",
      reference: string };
```

`employeeSafeReference` is intentionally a placeholder for the
adapter to resolve to `Employee.employeeNumber` — a stable safe
reference. SIN is NEVER in remittance information.

## 5. Mapping to ISO 20022 (conceptual)

The below maps Spectre concepts to ISO 20022 message concepts as a
readiness exercise. Definitive mapping requires the actual message
schema version required by the settlement agent + institution.

| Spectre concept | Canonical field | ISO 20022 (pain.001-class) | Status |
|---|---|---|---|
| Club (initiating party) | `clubId` | `InitgPty.Id` | **[Gap]** Requires institution's initiating-party identification code. |
| Debtor (the club) | `debtorFundingBankAccountId` | `Dbtr.Nm` + `Dbtr.Id` | **[Known]** ClubProfile provides name; identification code requires institution config. |
| Debtor account | `debtorFundingBankAccountId` + snapshot | `DbtrAcct.Id.Othr.Id` | **[Known]** Institution + transit + account references live on the funding account (KMS-referenced). |
| Creditor | `creditorRecipientId` + destination snapshot | `Cdtr.Nm` | **[Gap]** Institution may require full legal name; Spectre must decide whether to expose employee legal name (yes, standard payroll practice). |
| Creditor account | `creditorDestinationSnapshotId` | `CdtrAcct.Id.Othr.Id` | **[Known]** Referenced via destination snapshot; adapter decrypts through KMS. |
| Instructed amount | `amount` + `currency` | `InstdAmt` (amount + Ccy) | **[Known]** |
| Requested execution date | `requestedExecutionDate` | `ReqdExctnDt` | **[Known]** |
| End-to-end ID | `endToEndId` | `PmtId.EndToEndId` | **[Known]** |
| Payment info ID (batch) | (batch reference — TBD per adapter) | `PmtInfId` | **[Gap]** Adapter concern. |
| Instruction ID | `spectrePaymentInstructionId` | `PmtId.InstrId` | **[Known]** |
| Payment purpose | `remittance.purpose` | `Purp.Cd` | **[Gap]** Institution's purpose-code catalog needed. |
| Remittance info | `remittance` | `RmtInf.Ustrd` / `RmtInf.Strd` | **[Gap]** Institution may require structured; canonical currently produces unstructured. |
| Payment status | (from ExternalPaymentEvent + PaymentInstruction) | `pain.002` `TxSts` | **[Known]** Normalized status set already exists. |
| Return / rejection | `PaymentInstruction.returnCode` + description | `pain.002` `StsRsnInf` | **[Known]** |

Explicit gaps to resolve with the sponsor institution / settlement
agent:

- Charge bearer.
- Initiating-party identification code.
- Purpose-code catalog to be used.
- Structured vs unstructured remittance requirements.
- Any Canadian-rail-specific extensions to pain.001.

## 6. Correlation guarantee

Given an external reference on an acknowledgement or return, Spectre
correlates deterministically:

```
external reference (endToEndId)
    → CanonicalRailInstruction
    → PaymentInstruction
    → PaymentRun
    → PayrollBatch (if applicable)
```

See `correlateExternalReference` in `rail/canonical.ts`. Fuzzy
matching (name, similar amount, near-date) is refused.

## 7. Round-trip invariants

Round-trip proof — an authorized payroll PaymentInstruction is
derived to canonical form and back to a correlation target without
losing:

- amount precision;
- currency;
- destination identity;
- funding-account identity;
- economic (Spectre) identity;

and without leaking:

- `institutionSecretRef`;
- `transitSecretRef`;
- `accountSecretRef`.

Enforced by `assertNoBankSecretsInCanonical` +
`pay1c2-rail-mapping.test.ts`.

## 8. Batch semantics (future)

A future adapter may batch many CanonicalRailInstruction rows into
one external transport unit (AFT file, one pain.001 message). The
batch identity is TRANSPORT-level; it does NOT replace the
instruction's economic identity:

- `batchReference` — the adapter-generated batch/file ID.
- `submissionReference` — the send-attempt (rotates on retry).
- `instructionReference` — always the instruction's stable ID.

An acknowledgement at the FILE level does not mean the payment
settled. Settlement is the RECORD-level (per-instruction) event.

## 9. What PAY-1C does NOT do

- Does not generate a real AFT file.
- Does not generate real pain.001 XML.
- Does not connect to Payments Canada.
- Does not validate against Payments Canada's actual RTR message
  schema.
- Does not send any message to a real financial institution.

Any of these is a PAY-1D+ concern, following sponsor / settlement
agent + counsel workstreams.
