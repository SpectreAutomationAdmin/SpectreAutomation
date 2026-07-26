// Phase 11D — OpenAPI typed route registry.
//
// Every public API route declares its metadata here (path, method, scope,
// description, schema names). The OpenAPI spec is GENERATED from this
// registry, so adding a route in two places (handler + spec) is no longer
// possible — only the registry needs to be touched.
//
// To register a new route:
//   1. Call registerRoute({ ... }) once at module load (top of the route file).
//   2. Reference an existing schema name (or add it to schemas.ts).
//   3. The /api/openapi.json endpoint picks it up automatically.

export type OpenAPISchemaRef = string;

export type RegisteredRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;            // e.g. "/members"
  summary: string;
  description?: string;
  permission: string;      // permission key required (matches apiRoute())
  version: "v1";
  status: "stable" | "beta" | "deprecated";
  deprecatedAt?: string;   // ISO date — surfaced as the "deprecated" flag
  responseSchema: OpenAPISchemaRef;
  parameters?: Array<{ name: string; in: "query" | "path"; required?: boolean; schema: { type: string; enum?: string[]; maximum?: number; minimum?: number } }>;
  examples?: { curl?: string };
};

const REGISTRY = new Map<string, RegisteredRoute>();

export function registerRoute(route: RegisteredRoute): void {
  const key = `${route.method} ${route.path}`;
  REGISTRY.set(key, route);
}

export function listRoutes(): RegisteredRoute[] {
  return Array.from(REGISTRY.values()).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function findRoute(method: string, path: string): RegisteredRoute | undefined {
  return REGISTRY.get(`${method.toUpperCase()} ${path}`);
}

// ---------------------------------------------------------------------------
// Initial registration block — keeps Phase 9/10 routes in the registry.
// New routes register themselves from their own module via registerRoute().
// ---------------------------------------------------------------------------
const STANDARD_LIST_PARAMS = [
  { name: "limit", in: "query" as const, schema: { type: "integer", maximum: 200 } },
  { name: "cursor", in: "query" as const, schema: { type: "string" } },
];

export function ensureCoreRoutesRegistered() {
  registerRoute({ method: "GET", path: "/members", summary: "List members", permission: "members:read", version: "v1", status: "stable", responseSchema: "MemberList", parameters: STANDARD_LIST_PARAMS, examples: { curl: `curl -H "Authorization: Bearer $KEY" "$SPECTRE/api/v1/members?limit=50"` } });
  registerRoute({ method: "GET", path: "/vendors", summary: "List vendors", permission: "vendor:view", version: "v1", status: "stable", responseSchema: "VendorList", parameters: STANDARD_LIST_PARAMS });
  registerRoute({ method: "GET", path: "/inventory/items", summary: "List inventory items", permission: "inventory:read", version: "v1", status: "stable", responseSchema: "InventoryItemList", parameters: STANDARD_LIST_PARAMS });
  registerRoute({ method: "GET", path: "/tee-times", summary: "List upcoming tee times", permission: "lessons:view", version: "v1", status: "stable", responseSchema: "TeeTimeList", parameters: [...STANDARD_LIST_PARAMS, { name: "from", in: "query" as const, schema: { type: "string" } }, { name: "to", in: "query" as const, schema: { type: "string" } }] });
  registerRoute({ method: "GET", path: "/events", summary: "List club events", permission: "events:read", version: "v1", status: "stable", responseSchema: "EventList", parameters: STANDARD_LIST_PARAMS });
  registerRoute({ method: "GET", path: "/charges", summary: "List member charges (AR)", permission: "ar:read", version: "v1", status: "stable", responseSchema: "ChargeList", parameters: [...STANDARD_LIST_PARAMS, { name: "memberId", in: "query" as const, schema: { type: "string" } }, { name: "since", in: "query" as const, schema: { type: "string" } }] });
  registerRoute({ method: "GET", path: "/tournaments", summary: "List tournaments", permission: "lessons:view", version: "v1", status: "stable", responseSchema: "TournamentList" });
}
