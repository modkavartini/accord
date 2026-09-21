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

// ─── Choice matching ──────────────────────────────────────────────────────
// Deliberately literal. Accord never guesses that "College of Engineering
// Trivandrum" is "CET": an option matches only when it equals or contains
// the saved value or one of the user's own aliases (rule.choicePatterns).
// The only normalisation is cosmetic — case, punctuation, "&" → "and",
// filler words, and ordinals ("Third" = "3rd" = "3") — so wording
// differences never block a match the user clearly intended.
const STOPWORDS = new Set(['and', 'or', 'of', 'the', 'in', 'for', 'at', 'to', 'a', 'an', 'de']);
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
    .split(' ')
    .filter(t => t && !STOPWORDS.has(t))
    .map(t => ORDINALS[t] || t)
    .join(' ');
}
const compact = s => norm(s).replace(/ /g, '');
// Whole-word phrase containment: "kidangoor" in "college engineering kidangoor ce kgr".
const hasPhrase = (hay, needle) => ` ${hay} `.includes(` ${needle} `);

// Score how well a form option satisfies a needle (the value or an alias).
// 0 = no match. Higher = tighter fit, so a needle that names one option
// exactly beats one that merely appears inside several.
function scoreOption(option, needle) {
  const o = norm(option), n = norm(needle);
  if (!o || !n) return 0;
  if (o === n) return 100;
  const oc = compact(option), nc = compact(needle);
  if (oc === nc) return 98;
  // Needle appears whole inside the option — longer shared portion wins.
  if (hasPhrase(o, n)) return 80 + Math.round(12 * n.length / o.length);
  // Option appears whole inside the needle ("CSE" option, value "CSE (Computer Science)").
  if (hasPhrase(n, o)) return 70 + Math.round(12 * o.length / n.length);
  // Spacing/hyphen variants: "CEKGR" ↔ "(CE-KGR)". Four chars minimum so a
  // short alias can't hit an accidental substring.
  if (nc.length >= 4 && oc.includes(nc)) return 60 + Math.round(12 * nc.length / oc.length);
  return 0;
}

/**
 * Pick the option(s) a rule should select on a choice question.
 *
 * Explicit mode (rule.choiceMatch is contains / startsWith / endsWith /
 * equals AND rule.choicePatterns is non-empty): an option matches when ANY
 * alias matches it under that operator.
 *
 * Auto mode (default): the saved value and the rule's aliases are tried in
 * that order against every option; the tightest literal fit wins. Nothing
 * is inferred — no acronyms, no fuzzy token overlap.
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
    let best = null, bestScore = 0;
    for (const n of [value, ...patterns].filter(Boolean)) {
      for (const o of options) {
        const s = scoreOption(o, n);
        if (s > bestScore) { bestScore = s; best = o; }
      }
    }
    if (best) values = [best];
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
