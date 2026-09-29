// Pure member helpers — no DB, no I/O — so they can be unit-tested with
// `node --test`.

// A member's gym / card "membership number" is DERIVED from their immutable
// member_id: it is therefore auto-assigned, unique for every member, and never
// changes for the same member (the id never changes). Staff don't type it.
//
// Format mirrors the existing data ("MM-1001", "MM-1002" …): a prefix plus the
// id offset so member 1 reads "MM-1001". The prefix is overridable per club via
// the MEMBERSHIP_NO_PREFIX env var (a public label, not a secret).
const PREFIX = process.env.MEMBERSHIP_NO_PREFIX || 'MM-';
const ID_OFFSET = 1000; // member_id 1 → "…1001", matching the seeded sample data

export function formatMembershipNo(memberId) {
  const n = Number(memberId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return `${PREFIX}${ID_OFFSET + n}`;
}

// The "expiring soon" window in days. Missing / invalid / non-positive input
// falls back to the 7-day default the dashboard uses; anything larger is clamped
// to a year so a runaway query param can't widen the report unbounded.
export function expiryWindowDays(days) {
  const n = Math.trunc(Number(days));
  if (!Number.isFinite(n) || n <= 0) return 7;
  return Math.min(n, 366);
}

// Every status member_overview can report — the All Members filter options.
export const MEMBER_STATUSES = ['Active', 'Upcoming', 'Paused', 'Inactive', 'No Plan'];

// WHERE clause + params for the All Members roster (name search + status),
// shared by the JSON list and the .xlsx export so the downloaded file always
// holds the same members as the table on screen. The status is whitelisted
// (never string-built into SQL); an unknown or blank one means "all statuses".
export function memberListFilter({ search = '', status = '' } = {}) {
  const conditions = [];
  const params = [];
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    conditions.push(`lower(full_name) LIKE $${params.length}`);
  }
  if (MEMBER_STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

// Sheet name + download filename for a roster export, e.g. 'No Plan' →
// "No Plan Members" / "members-no-plan-2026-09-29.xlsx". Derived from the
// whitelist, never raw query input, so nothing a caller sends can reach the
// Content-Disposition header. `date` is passed in (YYYY-MM-DD) to keep this pure.
export function memberExportNames(status, date) {
  const known = MEMBER_STATUSES.includes(status);
  const slug = known ? status.toLowerCase().replace(/\s+/g, '-') : 'all';
  return {
    sheet: known ? `${status} Members` : 'All Members',
    filename: `members-${slug}-${date}.xlsx`,
  };
}
