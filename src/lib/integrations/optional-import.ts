// Helper for optional runtime-only imports. Uses an indirect call so
// TypeScript doesn't try to resolve the module at compile time. Each integration
// adapter that depends on a heavy / optional SDK loads it through this helper.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = any;

export async function optionalImport(specifier: string): Promise<AnyModule | null> {
  try {
    // Indirect require/import keeps TypeScript and bundlers from trying to
    // statically resolve the module. The dynamic specifier means the next
    // line of TS treats this as `Promise<any>` — fine for our use case
    // because the adapter does its own duck-type checks.
    // eslint-disable-next-line no-new-func
    const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<AnyModule>;
    return await dynamicImport(specifier);
  } catch {
    return null;
  }
}
