// Side-effect import. Runs before any other module that touches
// process.env so .env / .env.local values are present when src/lib/env.ts
// performs its eager validation. Scripts MUST import this first:
//
//   import "./lib/preload-env";
//   import { env } from "../src/lib/env";

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
