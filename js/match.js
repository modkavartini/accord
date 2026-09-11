// Pure matching logic shared by the gate (fills forms) and the profile page
// (previews rules). No DOM, no Firebase — keep it that way so it stays easy
// to reason about and test.

// ─── Field normalization ──────────────────────────────────────────────────
// Fields arrive in three shapes: parse-form output ({entryId, label, type,
// options}), older saved accords ({entryId, dummyValue}), and the extension's
// schema (same as parse-form). Collapse them into one.
export function normalizeField(f) {
  if (!f || typeof f !== 'object') return null;
  const entryId = f.entryId;
  if (!entryId) return null;
  const label = ((f.label ?? f.dummyValue) || '').toString().trim();
  const out = { entryId, label };
  if (typeof f.type === 'number') out.type = f.type;
  if (Array.isArray(f.options) && f.options.length) out.options = f.options.map(String);
  if (f.hasOther) out.hasOther = true;
  if (typeof f.row === 'string' && f.row) out.row = f.row;
  return out;
}

export function normalizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map(normalizeField).filter(Boolean);
}

// Display label — grid rows read as "Question — Row".
export function fieldDisplayLabel(f) {
  const base = f.label || 'Untitled question';
  return f.row ? `${base} — ${f.row}` : base;
}

export const isChoiceField = f => Array.isArray(f?.options) && f.options.length > 0;
// Google Forms type 4 = checkboxes; the only type that accepts several values.
export const isMultiChoiceField = f => isChoiceField(f) && f.type === 4;

// ─── String matching primitives ───────────────────────────────────────────
export function matchStr(mode, haystack, needle) {
  const v  = (haystack || '').trim().toLowerCase();
  const pp = (needle   || '').trim().toLowerCase();
  if (!pp) return false;
  switch (mode) {
    case 'equals':     return v === pp;
    case 'contains':   return v.includes(pp);
    case 'startsWith': return v.startsWith(pp);
    case 'endsWith':   return v.endsWith(pp);
    default:           return false;
  }
}

// Does this rule apply to a question with this label?
export function matchRule(rule, label) {
  return (rule.patterns || []).some(p => matchStr(rule.match, label, p));
}

export function findMatchingRule(profile, label, usedRuleIds) {
  for (const rule of (profile?.fields || [])) {
    if (!matchRule(rule, label)) continue;
    // `firstOnly` (default ON) means a rule fires for at most one form
    // question per visit — handy when a form repeats "Confirm Email".
    if (usedRuleIds && rule.firstOnly !== false && usedRuleIds.has(rule.id)) continue;
    return rule;
  }
  return null;
}

// The raw value a rule produces, before any choice matching.
export function resolveRule(rule, user) {
  if (!rule) return null;
  if (rule.enabled === false) return null;
  if (rule.source === 'auth-name')  return user?.displayName || null;
  if (rule.source === 'auth-email') return user?.email       || null;
  return rule.value || null;
}

// ─── Smart choice matching ────────────────────────────────────────────────
const STOPWORDS = new Set(['and', 'or', 'of', 'the', 'in', 'for', 'at', 'to', 'a', 'an', 'de']);
// Ordinals collapse to digits so "Third" ↔ "3rd Year" ↔ "3" all agree.
const ORDINALS = {
  first: '1', '1st': '1', i: '1',
  second: '2', '2nd': '2', ii: '2',
  third: '3', '3rd': '3', iii: '3',
  fourth: '4', '4th': '4', iv: '4',
  fifth: '5', '5th': '5', v: '5',
  sixth: '6', '6th': '6', vi: '6',
  seventh: '7', '7th': '7',
  eighth: '8', '8th': '8',
};

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
const compact = s => norm(s).replace(/ /g, '');
// Significant tokens only: stopwords dropped, ordinals normalized.
function sigTokens(s) {
  return norm(s).split(' ').filter(t => t && !STOPWORDS.has(t)).map(t => ORDINALS[t] || t);
}
const acronym = s => sigTokens(s).map(t => t[0]).join('');

// Every acronym formable from a contiguous run of ≥2 significant tokens,
// mapped to the token indexes it covers. Lets an option token like "ce"
// stand in for "college engineering" inside a longer value.
function runAcronyms(toks) {
  const out = new Map();
  for (let i = 0; i < toks.length; i++) {
    let acc = '';
    for (let j = i; j < toks.length && j < i + 6; j++) {
      acc += toks[j][0];
      if (j > i) out.set(acc, [i, j]);
    }
  }
  return out;
}

// Score how well a form option satisfies a profile value. 0 = no match.
// `weight(token)` favours tokens that are rare across the option set, so
// "kidangoor" outranks "college"/"engineering" that every option shares.
function scoreOption(option, needle, weight) {
  const o = norm(option), n = norm(needle);
  if (!o || !n) return 0;
  if (o === n) return 100;
  const oc = compact(option), nc = compact(needle);
  if (oc === nc) return 98;
  // Whole-string acronym in either direction: value "Computer Science and
  // Engineering" vs option "CSE", or value "CSE" vs option "Computer Science".
  const oa = acronym(option), na = acronym(needle);
  if (oa.length >= 2 && oa === nc) return 92;
  if (na.length >= 2 && na === oc) return 92;
  // Whole containment — longer shared portion wins.
  if (o.includes(n)) return 80 + Math.round(12 * n.length / o.length);
  if (n.includes(o)) return 70 + Math.round(12 * o.length / n.length);

  // Weighted token coverage with acronym expansion.
  const ot = sigTokens(option), nt = sigTokens(needle);
  if (!ot.length || !nt.length) return 0;
  const nAcr = runAcronyms(nt), oAcr = runAcronyms(ot);
  const coveredN = new Set(), coveredO = new Set();
  ot.forEach((t, oi) => {
    const ni = nt.indexOf(t);
    if (ni >= 0) { coveredN.add(ni); coveredO.add(oi); return; }
    const run = nAcr.get(t);           // option token is an acronym of needle tokens
    if (run) { for (let k = run[0]; k <= run[1]; k++) coveredN.add(k); coveredO.add(oi); }
  });
  nt.forEach((t, ni) => {
    const run = oAcr.get(t);           // needle token is an acronym of option tokens
    if (run) { for (let k = run[0]; k <= run[1]; k++) coveredO.add(k); coveredN.add(ni); }
  });
  if (!coveredN.size) return 0;
  const w = t => weight ? weight(t) : 1;
  const sum = (arr, pred) => arr.reduce((a, t, i) => a + (pred(i) ? w(t) : 0), 0);
  const shared = sum(nt, i => coveredN.has(i)) + sum(ot, i => coveredO.has(i));
  const total  = sum(nt, () => true)          + sum(ot, () => true);
  return Math.round(60 * shared / total);
}

// Rarity weight for tokens across an option set: a token present in every
// option carries little signal; a token unique to one option carries a lot.
function tokenWeighter(options) {
  const df = new Map();
  for (const o of options) {
    for (const t of new Set(sigTokens(o))) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = Math.max(options.length, 1);
  return t => 1 / (1 + (df.get(t) || 0) / N * 3);
}

const AUTO_THRESHOLD = 30;

/**
 * Pick the option(s) a rule should select on a choice question.
 *
 * Explicit mode (rule.choiceMatch is contains / startsWith / endsWith /
 * equals AND rule.choicePatterns is non-empty): an option matches when ANY
 * pattern matches it under that operator.
 *
 * Auto mode (default): score every option against the rule's value plus any
 * choice patterns, and take the best one above a threshold. Handles exact,
 * acronym ("CSE" ↔ "Computer Science and Engineering"), containment and
 * token-overlap matches.
 *
 * Returns { values: string[], other?: string }. `values` is empty when
 * nothing matched; `other` is set when the question has an "Other…" option
 * and we should fall back to typing the raw value there.
 */
export function pickChoices(rule, value, field) {
  const options = field.options || [];
  const patterns = (rule?.choicePatterns || []).map(p => (p || '').trim()).filter(Boolean);
  const mode = rule?.choiceMatch || 'auto';
  const multi = isMultiChoiceField(field);

  let values = [];
  if (mode !== 'auto' && patterns.length) {
    values = options.filter(o => patterns.some(p => matchStr(mode, o, p)));
    if (!multi) values = values.slice(0, 1);
  } else {
    const needles = [value, ...patterns].filter(Boolean);
    const weight = tokenWeighter(options);
    let best = null, bestScore = 0;
    for (const o of options) {
      for (const n of needles) {
        const s = scoreOption(o, n, weight);
        if (s > bestScore) { bestScore = s; best = o; }
      }
    }
    if (best && bestScore >= AUTO_THRESHOLD) values = [best];
  }

  if (values.length) return { values };
  if (field.hasOther && value) return { values: [], other: value };
  return { values: [] };
}

/**
 * Full resolution for one field: which rule fires, and what gets sent.
 * Returns null when nothing applies, else
 *   { rule, value, values: string[], other?: string, unmatched?: true }
 * `unmatched` means a rule matched the question but none of its options
 * fit the value (and there's no "Other") — surfaced in the preview so the
 * user knows to add a choice pattern.
 */
export function resolveField(profile, field, user, usedRuleIds) {
  const rule = findMatchingRule(profile, field.label, usedRuleIds);
  const value = resolveRule(rule, user);
  if (!value) return null;
  if (!isChoiceField(field)) return { rule, value, values: [value] };
  const picked = pickChoices(rule, value, field);
  if (picked.values.length) return { rule, value, values: picked.values };
  if (picked.other)         return { rule, value, values: [], other: picked.other };
  return { rule, value, values: [], unmatched: true };
}

// Google's prefill key for the free-text half of an "Other…" choice.
export const OTHER_SENTINEL = '__other_option__';
export const otherResponseKey = entryId => `${entryId}.other_option_response`;
