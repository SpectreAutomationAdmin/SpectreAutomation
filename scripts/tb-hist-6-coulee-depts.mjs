// Read Coulee's full existing Department catalog on staging.
// Read-only. No writes.
import { readFileSync } from 'node:fs';

try {
  const envText = readFileSync('.env.playwright.local', 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const BASE = 'https://staging.spectreautomation.com';

// Use Playwright for login — the login flow is form-based.
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[name="email"]').fill(process.env.SPECTRE_STAGING_EMAIL);
await page.locator('input[name="password"]').fill(process.env.SPECTRE_STAGING_PASSWORD);
await Promise.all([
  page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }),
  page.locator('form button[type="submit"]').first().click(),
]);

// Discover Coulee's clubId
const d = await (await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/cmuni5ymv000k136q3xdyrpmn`)).json();
console.log('Coulee clubId:', d.clubId);

// Pull current departments via the bootstrap GET
const plan = await (await page.request.get(`${BASE}/api/admin/jonas-departments-bootstrap?clubId=${d.clubId}`)).json();
console.log('\n--- CURRENT COULEE DEPARTMENTS ---');
for (const dep of plan.current) console.log(`  ${dep.code.padEnd(20)}  ${dep.name}  ${dep.isActive ? '' : '[inactive]'}`);
console.log(`  Total: ${plan.current.length}\n`);

console.log('--- TB-HIST-6 PLAN ---');
for (const p of plan.plan) console.log(`  ${p.want.code.padEnd(20)}  → ${p.action}  ${JSON.stringify(p.existing ?? p.existingByCode ?? '')}`);

await browser.close();
