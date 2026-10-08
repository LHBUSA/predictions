// Employment V1 as-published ledgers. Pure: parsed release records in, ledgers out.
//
// FIRST PRINT of month X for a series = the value in the EARLIEST release (by embargo time) that prints a non-null value
// for X. That is the value Kalshi settles on. Later releases are kept as later prints (revisions) and never overwrite it.
// A month no release ever printed is INPUT_UNAVAILABLE, never 0 and never imputed.
import { etToUtcIso } from '../cpi/timeline.js';
import { shiftMonth } from './bls-empsit.js';

export const LEDGER_VERSION = 'employment-ledger/1';
export const releaseAtUtc = (r) => etToUtcIso(r.release_date, Number(r.release_time_et.slice(0, 2)), Number(r.release_time_et.slice(3, 5)));

function prints(releases, field) {
  const byMonth = new Map();
  for (const r of [...releases].sort((a, b) => releaseAtUtc(a).localeCompare(releaseAtUtc(b)))) {
    for (const [month, v] of Object.entries(r[field] || {})) {
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push({ value: v, release_date: r.release_date, release_at: releaseAtUtc(r), release_reference_month: r.reference_month, file_name: r.file_name, sha256: r.source_document_sha256 });
    }
  }
  return byMonth;
}

// One row per reference month that has a release of its own or appears in any release.
export function firstPrints(releases, { fromMonth = null } = {}) {
  const u3 = prints(releases, 'u3_by_month');
  const pay = prints(releases, 'payroll_change_k_by_month');
  const own = new Map(releases.map((r) => [r.reference_month, r]));
  // every month from the first release's reference month on that has its own release OR is printed in any release
  // (Oct 2025 had no release of its own; its payroll change first appears in the Nov 2025 release)
  const start = fromMonth || [...own.keys()].sort()[0];
  const months = [...new Set([...own.keys(), ...u3.keys(), ...pay.keys()])].filter((m) => m >= start).sort();
  const one = (list, month) => {
    const all = list.get(month) || [];
    const first = all.find((p) => p.value !== null && !Number.isNaN(p.value));
    if (!first) return { status: 'INPUT_UNAVAILABLE', value: null, reason: all.length ? 'PRINTED_AS_NOT_AVAILABLE' : 'NEVER_PRINTED', prints: all.length };
    return {
      status: 'OK', value: first.value, release_date: first.release_date, release_at: first.release_at, file_name: first.file_name, sha256: first.sha256,
      in_own_release: first.release_reference_month === month,
      later_prints: all.filter((p) => p.release_at > first.release_at && p.value !== null).map((p) => ({ value: p.value, release_date: p.release_date })),
    };
  };
  return months.map((m) => ({
    reference_month: m,
    own_release: own.has(m) ? { release_date: own.get(m).release_date, release_at: releaseAtUtc(own.get(m)), file_name: own.get(m).file_name, reissued: own.get(m).reissued ?? null } : null,
    u3: one(u3, m),
    payroll_change_k: one(pay, m),
  }));
}

// U-3 for month M as printed in the M+1 release must equal the first print, except in January-data releases (annual
// seasonal-factor revision of the prior 5 years). Returns every exception so a reviewer can see each one.
export function u3ReprintConsistency(releases) {
  const byRef = new Map(releases.map((r) => [r.reference_month, r]));
  const out = { checked: 0, equal: 0, january_revisions: 0, mismatches: [] };
  for (const r of releases) {
    const next = byRef.get(shiftMonth(r.reference_month, 1));
    if (!next) continue;
    const a = r.u3_by_month[r.reference_month]; const b = next.u3_by_month?.[r.reference_month];
    if (a === null || a === undefined || b === undefined) continue;
    out.checked += 1;
    if (a === b) out.equal += 1;
    else if (next.reference_month.endsWith('-01')) out.january_revisions += 1;
    else out.mismatches.push({ month: r.reference_month, first: a, next_release: next.release_date, reprinted: b });
  }
  return out;
}
