// TB-HIST-5 — read-only staging coverage check. Does Coulee's COA
// contain every source account? Does Coulee have Departments?
// Uses the authenticated staging session via a cookie jar.
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';

// Minimal dotenv-free loader for .env.playwright.local
try {
  const envText = readFileSync('.env.playwright.local', 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const BASE = 'https://staging.spectreautomation.com';
const email = process.env.SPECTRE_STAGING_EMAIL;
const pw = process.env.SPECTRE_STAGING_PASSWORD;
if (!email || !pw) { console.error('MISSING STAGING CREDS'); process.exit(1); }

// Login
const r1 = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pw }),
});
const cookies = (r1.headers.getSetCookie?.() ?? [r1.headers.get('set-cookie')]).filter(Boolean).map(s => s.split(';')[0]).join('; ');
if (r1.status !== 200) { console.error('LOGIN', r1.status); process.exit(2); }

// Load the real workbook (read-only)
const buf = readFileSync('C:/Users/cturcato/Downloads/December 31, 2025 TB Departmental.xlsx');
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const sheet = wb.worksheets[0];
const cellToStr = v => v == null ? '' : (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : (v?.text ?? (v?.result != null ? cellToStr(v.result) : String(v)))));

const sourceAccts = new Set();
const sourceDepts = new Map();
for (let r = 5; r <= sheet.rowCount; r++) {
  const acct = cellToStr(sheet.getRow(r).getCell(1).value).trim();
  const dept = cellToStr(sheet.getRow(r).getCell(3).value).trim();
  const deptDesc = cellToStr(sheet.getRow(r).getCell(4).value).trim();
  if (acct) sourceAccts.add(acct);
  if (dept) sourceDepts.set(dept, deptDesc);
}

// Fetch COA diagnostic (lists Coulee's import rows → accounts)
const BATCH = 'cmuni5ymv000k136q3xdyrpmn';
const r2 = await fetch(`${BASE}/api/admin/coa-batch-diagnostic/${BATCH}`, { headers: { Cookie: cookies } });
const diag = await r2.json();
console.log('BATCH STATUS:', diag.status, '| total:', diag.total, '| club counts:', diag.club);
// The diagnostic doesn't list every row's accountNumber directly, but violations[].accountNumber is for offenders only.
// We need the full COA list — use the standard COA listing endpoint if one exists; otherwise fetch via Prisma proxy if available.

// Try the batches listing + a per-batch rows listing (if an endpoint exists)
// Fallback: hit the COA page's JSON if any
console.log('\nTrying to fetch Spectre COA to compute coverage...');
const tryEndpoints = [
  '/api/admin/coa/accounts?limit=1000',
  '/api/admin/accounts?limit=1000',
  '/api/admin/coa-batch-diagnostic/' + BATCH + '?dump=1',
];
let foundAccts = null;
for (const path of tryEndpoints) {
  const rr = await fetch(BASE + path, { headers: { Cookie: cookies } });
  const txt = await rr.text();
  console.log(`  ${path} → ${rr.status} · ${txt.slice(0,120).replace(/\n/g,' ')}`);
  if (rr.status === 200 && (txt.includes('accountNumber') || txt.includes('"accounts"'))) {
    try {
      const j = JSON.parse(txt);
      const list = Array.isArray(j) ? j : (j.accounts ?? j.rows ?? j.items ?? j.data);
      if (Array.isArray(list)) {
        foundAccts = new Set(list.map(a => (a.accountNumber ?? a.number ?? a.code ?? '').toString().trim()).filter(Boolean));
        console.log(`  → extracted ${foundAccts.size} accounts from ${path}`);
        break;
      }
    } catch {}
  }
}

if (!foundAccts) {
  // Try the Departments list
  const dr = await fetch(`${BASE}/api/admin/departments`, { headers: { Cookie: cookies } });
  console.log('\n/api/admin/departments →', dr.status);
  if (dr.ok) {
    try { const dj = await dr.json(); console.log('departments:', dj); } catch {}
  }
  console.log('\nSource account unique count:', sourceAccts.size);
  console.log('Source dept unique count:', sourceDepts.size);
  console.log('Sample source accts (first 20):', [...sourceAccts].sort().slice(0, 20).join(', '));
  console.log('Source depts:');
  for (const [code, desc] of [...sourceDepts.entries()].sort()) console.log(`  ${code}  ${desc}`);
  process.exit(0);
}

const unknown = [...sourceAccts].filter(a => !foundAccts.has(a));
console.log('\n--- COA COVERAGE ---');
console.log('Source unique accounts:', sourceAccts.size);
console.log('Spectre accounts total:', foundAccts.size);
console.log('Unknown-to-Spectre:', unknown.length);
if (unknown.length > 0) console.log('  first 20 unknown:', unknown.slice(0, 20).join(', '));

// Fetch Departments
const dr = await fetch(`${BASE}/api/admin/departments`, { headers: { Cookie: cookies } });
console.log('\n/api/admin/departments →', dr.status);
if (dr.ok) {
  const dj = await dr.json();
  console.log('departments response:', JSON.stringify(dj).slice(0, 500));
}
