// TB-HIST-5 read-only diagnostic — audit the founder's real
// departmental workbook. No writes. No side effects.
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';

const FILE = 'C:/Users/cturcato/Downloads/December 31, 2025 TB Departmental.xlsx';
const buf = readFileSync(FILE);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const sheet = wb.worksheets[0];
console.log('SHEET:', sheet.name, '| rowCount:', sheet.rowCount, '| columnCount:', sheet.columnCount);

const cellToStr = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0,10);
  if (typeof v === 'object' && v.text) return v.text;
  if (typeof v === 'object' && v.result != null) return cellToStr(v.result);
  return String(v);
};

// Dump first 10 rows (preamble + header + first data rows)
console.log('\n--- FIRST 10 ROWS ---');
for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
  const cells = [];
  for (let c = 1; c <= sheet.columnCount; c++) {
    cells.push(cellToStr(sheet.getRow(r).getCell(c).value));
  }
  console.log(`R${r}:`, JSON.stringify(cells));
}

// Walk every row, collect metrics.
let total = 0, dataRows = 0, preambleRows = 0, headerFound = -1;
const deptMap = new Map();   // dept code → description
const accountCodes = new Set();
const dimKeys = new Map();   // "acctCode|deptCode" → count
const subAcctCodes = new Set();
const subAcctDescs = new Set();
let sumDebit = 0, sumCredit = 0;
let negativeCreditCount = 0, negativeDebitCount = 0;

// Column indices (set after header detection)
let COL_ACCT=-1, COL_ACCT_DESC=-1, COL_DEPT=-1, COL_DEPT_DESC=-1, COL_SUB=-1, COL_SUB_DESC=-1, COL_DEBIT=-1, COL_CREDIT=-1;

for (let r = 1; r <= sheet.rowCount; r++) {
  total++;
  const cells = [];
  for (let c = 1; c <= sheet.columnCount; c++) cells.push(cellToStr(sheet.getRow(r).getCell(c).value));

  // Header detection — cells may contain embedded newlines, so
  // whitespace-collapse each cell first.
  if (headerFound < 0) {
    const collapsed = cells.map(c => c.replace(/\s+/g, ' ').trim().toLowerCase());
    const flat = collapsed.join(' | ');
    if (/g\/?l\s*account\s*code/.test(flat) && /closing\s*bal/.test(flat)) {
      headerFound = r;
      collapsed.forEach((low, i) => {
        if (/g\/?l\s*account\s*code/.test(low)) COL_ACCT = i;
        else if (/g\/?l\s*account\s*description/.test(low)) COL_ACCT_DESC = i;
        else if (/g\/?l\s*department\s*code/.test(low)) COL_DEPT = i;
        else if (/g\/?l\s*department\s*description/.test(low)) COL_DEPT_DESC = i;
        else if (/g\/?l\s*sub[- ]*account\s*code/.test(low)) COL_SUB = i;
        else if (/g\/?l\s*sub[- ]*account\s*description/.test(low)) COL_SUB_DESC = i;
        else if (/closing\s*bal.*debit/.test(low)) COL_DEBIT = i;
        else if (/closing\s*bal.*credit/.test(low)) COL_CREDIT = i;
      });
      console.log('\nHEADER AT ROW', r, 'INDICES:', {COL_ACCT,COL_ACCT_DESC,COL_DEPT,COL_DEPT_DESC,COL_SUB,COL_SUB_DESC,COL_DEBIT,COL_CREDIT});
      continue;
    }
    preambleRows++;
    continue;
  }

  const acct = cells[COL_ACCT]?.trim();
  if (!acct || /^(grand\s*total|net\s*income|$)/i.test(acct)) continue;
  dataRows++;
  const acctDesc = cells[COL_ACCT_DESC]?.trim() ?? '';
  const dept = cells[COL_DEPT]?.trim() ?? '';
  const deptDesc = cells[COL_DEPT_DESC]?.trim() ?? '';
  const sub = cells[COL_SUB]?.trim() ?? '';
  const subDesc = cells[COL_SUB_DESC]?.trim() ?? '';
  const debitStr = cells[COL_DEBIT]?.replace(/[$,()]/g, '').trim() ?? '';
  const creditStr = cells[COL_CREDIT]?.replace(/[$,()]/g, '').trim() ?? '';
  const debit = Number(debitStr) || 0;
  const credit = Number(creditStr) || 0;

  accountCodes.add(acct);
  if (dept) deptMap.set(dept, deptDesc);
  const dimKey = `${acct}|${dept}`;
  dimKeys.set(dimKey, (dimKeys.get(dimKey)||0)+1);
  if (sub) subAcctCodes.add(sub);
  if (subDesc) subAcctDescs.add(subDesc);
  sumDebit += Math.abs(debit);
  sumCredit += Math.abs(credit);
  if (debit < 0) negativeDebitCount++;
  if (credit < 0) negativeCreditCount++;
}

console.log('\n--- COUNTS ---');
console.log('Total worksheet rows (header+data):', total);
console.log('Preamble rows (pre-header):', preambleRows);
console.log('Header row at:', headerFound);
console.log('Data rows:', dataRows);
console.log('Unique account codes:', accountCodes.size);
console.log('Unique dimensional keys (acct|dept):', dimKeys.size);
const multiDeptAccts = [...dimKeys.entries()].filter(([k,v]) => v > 1);
console.log('Dimensional-key duplicates (same acct+dept appear >1x):', multiDeptAccts.length);
console.log('Accounts appearing in multiple departments:');
const perAcctDeptCount = new Map();
for (const key of dimKeys.keys()) {
  const [acct] = key.split('|');
  perAcctDeptCount.set(acct, (perAcctDeptCount.get(acct)||0)+1);
}
const multi = [...perAcctDeptCount.entries()].filter(([,n]) => n > 1).map(([a,n]) => `${a}=${n}`);
console.log(`  ${multi.length} accounts (first 10):`, multi.slice(0,10).join(', '));

console.log('\n--- DEPARTMENTS (source Code → Description) ---');
const sortedDepts = [...deptMap.entries()].sort(([a],[b]) => a.localeCompare(b));
for (const [code, desc] of sortedDepts) console.log(`  ${code}  ${desc}`);
console.log('TOTAL DISTINCT DEPARTMENTS:', deptMap.size);

console.log('\n--- SUB-ACCOUNT ---');
console.log('Rows with any sub-account code:', subAcctCodes.size);
console.log('Rows with any sub-account description:', subAcctDescs.size);
if (subAcctCodes.size > 0) console.log('  sample codes:', [...subAcctCodes].slice(0,10).join(', '));
if (subAcctDescs.size > 0) console.log('  sample descs:', [...subAcctDescs].slice(0,10).join(', '));

console.log('\n--- RECONCILIATION ---');
console.log('Σ|debit|:  ', sumDebit.toFixed(2));
console.log('Σ|credit|: ', sumCredit.toFixed(2));
console.log('|Δ|:       ', Math.abs(sumDebit - sumCredit).toFixed(2));
console.log('Negative-debit rows: ', negativeDebitCount, '  Negative-credit rows:', negativeCreditCount);

console.log('\n--- SAMPLE ACCOUNT CODES ---');
const sortedAccts = [...accountCodes].sort();
console.log('First 10:', sortedAccts.slice(0, 10).join(', '));
console.log('Last 10:', sortedAccts.slice(-10).join(', '));
console.log('Account code lengths:', [...new Set(sortedAccts.map(a => a.length))].sort());
