// Phase 9A — Observability adapter architecture.
//
// One interface wraps three concerns:
//   - Tracing (OpenTelemetry spans)
//   - Metrics (Prometheus counters/histograms)
//   - Error reporting (Sentry)
//
// The default adapter writes to the structured logger + persists durable
// rollups to `ObservabilityEvent` / `MetricCounter`. Production wires in
// `otelAdapter` / `prometheusAdapter` / `sentryAdapter` via env config.
//
// Correlation IDs propagate through the existing AsyncLocalStorage from
// Phase 8, so traces sit on top of the logger without changing call sites.

import { prisma } from "../prisma";
import { logger, getCorrelationId, newCorrelationId } from "./logger";
import { optionalImport } from "../integrations/optional-import";

export interface Span {
  name: string;
  start: number;
  attrs: Record<string, unknown>;
  end(outcome?: "OK" | "WARN" | "ERROR", message?: string): Promise<void>;
  setAttr(k: string, v: unknown): void;
}

export interface ObservabilityAdapter {
  name: string;
  startSpan(name: string, attrs?: Record<string, unknown>): Span;
  incrCounter(name: string, labels?: Record<string, string>, value?: number): void;
  recordError(error: unknown, attrs?: Record<string, unknown>): void;
  exportMetrics(): Promise<string>; // Prometheus text exposition
}

// ---------------------------------------------------------------------------
// In-memory + persistence adapter (always available).
// ---------------------------------------------------------------------------
type CounterKey = string;
const counters = new Map<CounterKey, number>();
function counterKey(name: string, labels: Record<string, string>): string {
  const sorted = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",");
  return sorted ? `${name}{${sorted}}` : name;
}

function persistEventBackground(name: string, kind: string, status: "OK" | "WARN" | "ERROR", correlationId: string | null, durationMs: number | null, message: string | null, attrs: Record<string, unknown>) {
  // Fire-and-forget — never block the caller on DB write.
  void prisma.observabilityEvent.create({
    data: {
      kind, name, status, correlationId,
      durationMs: durationMs ?? null,
      message,
      metaJson: Object.keys(attrs).length > 0 ? JSON.stringify(attrs) : null,
      clubId: (attrs.clubId as string | undefined) ?? null,
    },
  }).catch((err) => logger.warn("observability.persist_failed", { error: err instanceof Error ? err.message : String(err) }));
}

export const defaultObservabilityAdapter: ObservabilityAdapter = {
  name: "default",
  startSpan(name, attrs = {}) {
    const start = Date.now();
    const all = { ...attrs };
    const correlationId = getCorrelationId() ?? newCorrelationId();
    logger.info("trace.span.start", { name, correlationId, ...all });
    return {
      name, start, attrs: all,
      setAttr(k, v) { all[k] = v; },
      async end(outcome = "OK", message) {
        const durationMs = Date.now() - start;
        all["outcome"] = outcome;
        if (message) all["message"] = message;
        logger.info("trace.span.end", { name, correlationId, durationMs, ...all });
        persistEventBackground(name, "SPAN", outcome, correlationId, durationMs, message ?? null, all);
      },
    };
  },
  incrCounter(name, labels = {}, value = 1) {
    const key = counterKey(name, labels);
    counters.set(key, (counters.get(key) ?? 0) + value);
    // Async durable rollup. Not awaited.
    void prisma.metricCounter.upsert({
      where: { name_labels: { name, labels: JSON.stringify(labels) } },
      update: { value: counters.get(key) ?? 0 },
      create: { name, labels: JSON.stringify(labels), value: counters.get(key) ?? 0 },
    }).catch((err) => logger.warn("metric.persist_failed", { name, error: err instanceof Error ? err.message : String(err) }));
  },
  recordError(error, attrs = {}) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("error.recorded", { message, stack, ...attrs });
    persistEventBackground("error", "ERROR", "ERROR", getCorrelationId(), null, message, { ...attrs, stack });
    this.incrCounter("spectre_errors_total", { kind: (attrs.kind as string) ?? "unknown" });
  },
  async exportMetrics() {
    // Pull persistent counters + in-memory; emit Prometheus text format.
    const rows = await prisma.metricCounter.findMany({ orderBy: { name: "asc" } });
    const lines: string[] = [];
    const seenHelps = new Set<string>();
    for (const r of rows) {
      const labels = JSON.parse(r.labels) as Record<string, string>;
      const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",");
      if (!seenHelps.has(r.name)) {
        lines.push(`# HELP ${r.name} Spectre counter`);
        lines.push(`# TYPE ${r.name} counter`);
        seenHelps.add(r.name);
      }
      lines.push(`${r.name}${labelStr ? `{${labelStr}}` : ""} ${r.value.toString()}`);
    }
    // Include in-memory only counters that haven't yet flushed.
    for (const [k, v] of counters.entries()) {
      if (!rows.some((r) => counterKey(r.name, JSON.parse(r.labels)) === k)) {
        lines.push(`${k} ${v}`);
      }
    }
    return lines.join("\n") + "\n";
  },
};

// ---------------------------------------------------------------------------
// OpenTelemetry adapter — dynamic-import; layers on top of the default.
//
// Phase 10G: real OTLP HTTP exporter when `@opentelemetry/sdk-trace-node` +
// `@opentelemetry/exporter-trace-otlp-http` are installed.
// ---------------------------------------------------------------------------
export async function otelAdapter(args: { serviceName: string; otlpEndpoint?: string }): Promise<ObservabilityAdapter | null> {
  const api = await optionalImport("@opentelemetry/api");
  if (!api) return null;
  const sdk = await optionalImport("@opentelemetry/sdk-trace-node");
  const exporter = await optionalImport("@opentelemetry/exporter-trace-otlp-http");
  const resources = await optionalImport("@opentelemetry/resources");
  let tracer: { startSpan: (name: string, opts?: Record<string, unknown>) => { setAttribute: (k: string, v: unknown) => void; setStatus: (s: { code: number; message?: string }) => void; end: () => void; spanContext: () => { traceId: string; spanId: string } } } | null = null;
  try {
    if (sdk && exporter && resources) {
      const { NodeTracerProvider, BatchSpanProcessor } = sdk;
      const provider = new NodeTracerProvider({
        resource: new resources.Resource({ "service.name": args.serviceName }),
      });
      const otlp = new exporter.OTLPTraceExporter({ url: args.otlpEndpoint });
      provider.addSpanProcessor(new BatchSpanProcessor(otlp));
      provider.register();
      tracer = api.trace.getTracer(args.serviceName);
    }
  } catch { /* fall back to logger-only */ }

  return {
    name: `otel:${args.serviceName}`,
    incrCounter: defaultObservabilityAdapter.incrCounter,
    recordError: defaultObservabilityAdapter.recordError,
    exportMetrics: defaultObservabilityAdapter.exportMetrics,
    startSpan(name, attrs = {}) {
      const correlationId = getCorrelationId() ?? newCorrelationId();
      const otSpan = tracer ? tracer.startSpan(name, { attributes: { ...attrs, correlationId } }) : null;
      const start = Date.now();
      logger.info("trace.span.start", { name, correlationId, ...attrs });
      const innerAttrs: Record<string, unknown> = { ...attrs };
      return {
        name, start, attrs: innerAttrs,
        setAttr(k, v) { innerAttrs[k] = v; otSpan?.setAttribute(k, v as never); },
        async end(outcome = "OK", message) {
          const durationMs = Date.now() - start;
          innerAttrs["outcome"] = outcome;
          if (message) innerAttrs["message"] = message;
          if (otSpan) {
            otSpan.setStatus({ code: outcome === "OK" ? 1 : 2, message });
            otSpan.end();
          }
          logger.info("trace.span.end", { name, correlationId, durationMs, ...innerAttrs });
          persistEventBackground(name, "SPAN", outcome, correlationId, durationMs, message ?? null, innerAttrs);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sentry adapter — dynamic-import.
// ---------------------------------------------------------------------------
export async function sentryAdapter(args: { dsn: string }): Promise<ObservabilityAdapter | null> {
  const mod = await optionalImport("@sentry/node");
  if (!mod) return null;
  try {
    mod.init({ dsn: args.dsn });
  } catch { /* ignore */ }
  return {
    ...defaultObservabilityAdapter,
    name: "sentry",
    recordError(error, attrs) {
      try { mod.captureException(error, { extra: attrs }); } catch { /* ignore */ }
      defaultObservabilityAdapter.recordError(error, attrs);
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
let activeAdapter: ObservabilityAdapter = defaultObservabilityAdapter;
export function getObservability(): ObservabilityAdapter { return activeAdapter; }
export function setObservability(a: ObservabilityAdapter) { activeAdapter = a; }

// Helper that wraps an async function with a span. The function receives
// the span so it can set additional attrs.
export async function trace<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = activeAdapter.startSpan(name, attrs);
  try {
    const result = await fn(span);
    await span.end("OK");
    return result;
  } catch (err) {
    span.setAttr("error", err instanceof Error ? err.message : String(err));
    await span.end("ERROR", err instanceof Error ? err.message : String(err));
    activeAdapter.recordError(err, { span: name, ...attrs });
    throw err;
  }
}
