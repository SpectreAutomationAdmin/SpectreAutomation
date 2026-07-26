// Phase 8F — Structured logger.
//
// One-line JSON logs for ingest by Cloudwatch / Datadog / Honeycomb.
// Correlation IDs flow through `withCorrelation(id, fn)` and are picked up
// from a Node async-local-storage so workers + handlers can log without
// passing the ID explicitly.

import { AsyncLocalStorage } from "node:async_hooks";

type LogLevel = "debug" | "info" | "warn" | "error";

type CorrelationContext = { correlationId: string; clubId?: string | null; userId?: string | null };

const als = new AsyncLocalStorage<CorrelationContext>();

const REDACT_KEYS = new Set(["password", "passwordHash", "secret", "apiKey", "accessKeyId", "secretAccessKey", "authToken", "processorToken", "ssn", "sin", "cardNumber", "cvv"]);

function emit(level: LogLevel, event: string, meta?: Record<string, unknown>) {
  const ctx = als.getStore();
  const row = {
    ts: new Date().toISOString(),
    level,
    event,
    correlationId: ctx?.correlationId,
    clubId: ctx?.clubId ?? undefined,
    userId: ctx?.userId ?? undefined,
    ...(meta ? redact(meta) : {}),
  };
  if (process.env.NODE_ENV === "test") return; // tests stay quiet
  const line = JSON.stringify(row);
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k)) { out[k] = "[redacted]"; continue; }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const logger = {
  debug(event: string, meta?: Record<string, unknown>) { emit("debug", event, meta); },
  info(event: string, meta?: Record<string, unknown>) { emit("info", event, meta); },
  warn(event: string, meta?: Record<string, unknown>) { emit("warn", event, meta); },
  error(event: string, meta?: Record<string, unknown>) { emit("error", event, meta); },
};

export function withCorrelation<T>(ctx: CorrelationContext, fn: () => Promise<T> | T): Promise<T> | T {
  return als.run(ctx, fn);
}

export function getCorrelationId(): string | null {
  return als.getStore()?.correlationId ?? null;
}

// Generate a request correlation ID (uuid-ish). Avoids the `uuid` dep.
export function newCorrelationId(): string {
  const r = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${r}`;
}
