// Phase 11D — OpenAPI spec built from the typed route registry.
//
// /api/openapi.json calls buildOpenAPI(baseUrl). The spec is GENERATED from
// the registry — adding a route to the registry surfaces it in the spec
// without further edits.

import { listRoutes, ensureCoreRoutesRegistered } from "./registry";

export type OpenAPIDocument = {
  openapi: "3.0.3";
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string }>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
  security: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, unknown>>;
};

// Curated schemas — keep narrow; expand as new shapes are added.
const SCHEMAS: Record<string, unknown> = {
  Member: { type: "object", properties: {
    id: { type: "string" }, memberNumber: { type: "string" },
    firstName: { type: "string" }, lastName: { type: "string" },
    email: { type: "string" }, status: { type: "string" },
    membershipCategory: { type: "string", nullable: true },
  } },
  Vendor: { type: "object", properties: { id: { type: "string" }, legalName: { type: "string" }, status: { type: "string" } } },
  InventoryItem: { type: "object", properties: { id: { type: "string" }, sku: { type: "string" }, name: { type: "string" }, quantityOnHand: { type: "number" }, averageCost: { type: "number" } } },
  TeeTime: { type: "object", properties: { id: { type: "string" }, startTime: { type: "string", format: "date-time" }, status: { type: "string" }, maxPlayers: { type: "integer" } } },
  Event: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, eventDate: { type: "string", format: "date-time" } } },
  Charge: { type: "object", properties: { id: { type: "string" }, memberId: { type: "string" }, amount: { type: "number" }, transactionDate: { type: "string", format: "date-time" }, status: { type: "string" } } },
  Tournament: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, format: { type: "string" }, status: { type: "string" } } },
  Error: { type: "object", properties: { error: { type: "string" } } },
};

function listSchema(itemRef: string) {
  return {
    type: "object",
    properties: {
      data: { type: "array", items: { $ref: `#/components/schemas/${itemRef}` } },
      nextCursor: { type: "string", nullable: true },
    },
  };
}

export function buildOpenAPI(baseUrl: string): OpenAPIDocument {
  ensureCoreRoutesRegistered();
  const routes = listRoutes();
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = { ...SCHEMAS };
  for (const route of routes) {
    const ref = route.responseSchema;
    if (ref.endsWith("List")) {
      const item = ref.replace(/List$/, "");
      if (!schemas[ref]) schemas[ref] = listSchema(item);
    }
    if (!paths[route.path]) paths[route.path] = {};
    const operation: Record<string, unknown> = {
      summary: route.summary,
      description: route.description,
      security: [{ ApiKeyAuth: [route.permission] }],
      parameters: route.parameters ?? [],
      deprecated: route.status === "deprecated",
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${route.responseSchema}` } } } },
        "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "429": { description: "Rate limited" },
      },
      "x-spectre-status": route.status,
      "x-spectre-version": route.version,
      ...(route.deprecatedAt ? { "x-spectre-deprecated-at": route.deprecatedAt } : {}),
      ...(route.examples?.curl ? { "x-spectre-example-curl": route.examples.curl } : {}),
    };
    paths[route.path][route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "Spectre Automation API",
      version: "v1",
      description: "External API for partner integrations. Requires a Bearer API key. All routes are tenant-scoped to the key's club.",
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "http", scheme: "bearer", bearerFormat: "Spectre API key" },
      },
      schemas,
    },
    security: [{ ApiKeyAuth: [] }],
    paths,
  };
}

export function validateRegistryCompleteness(): { ok: boolean; missing: string[] } {
  ensureCoreRoutesRegistered();
  const missing: string[] = [];
  const routes = listRoutes();
  for (const r of routes) {
    const ref = r.responseSchema;
    if (ref.endsWith("List")) {
      const item = ref.replace(/List$/, "");
      if (!SCHEMAS[item] && !SCHEMAS[ref]) missing.push(item);
    } else if (!SCHEMAS[ref]) {
      missing.push(ref);
    }
  }
  return { ok: missing.length === 0, missing };
}
