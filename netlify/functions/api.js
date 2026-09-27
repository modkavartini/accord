// Accord's read API — what a Google Form asks, as JSON, to anything that
// needs to know before a person opens it.
//
//   GET /api                     what this API offers
//   GET /api/form?url=<link>     the form's questions
//
// `url` takes any shape /fill takes: a full docs.google.com form URL, a
// forms.gle short link, a known shortener, or a bare form ID.
//
// The work is parse-form's — the same parser, the same Netlify Blob cache,
// the same reader Pi for sign-in-walled forms. This adds the stable public
// shape over it: question types spelled out in words rather than as Google's
// internal numbers, and a name for each thing that will not move when
// parse-form's internals do.
//
// Everything it reads is a form anybody with the link can already open, from
// hosts allow-listed in parse-form, so it stays open and CORS-wide like
// parse-form itself. Nothing about a form's *responses* is reachable here.
const parseForm = require('./parse-form');

// Google Forms' item types, as parse-form passes them through
// (FB_PUBLIC_LOAD_DATA_[1][1][i][3]).
const TYPE_NAMES = {
  0: 'short answer',
  1: 'paragraph',
  2: 'multiple choice',
  3: 'dropdown',
  4: 'checkboxes',
  5: 'linear scale',
  7: 'grid',
  8: 'section',
  9: 'date',
  10: 'time',
  13: 'file upload',
};

const INDEX = {
  name: 'Accord form API',
  docs: 'https://accord.modka.is-a.dev/fill',
  endpoints: {
    'GET /api/form?url=<google form link or id>':
      'The form title and its questions: entryId, label, type, required, and the options of every choice question.',
  },
  notes: [
    'url accepts a docs.google.com form URL, a forms.gle link, a common shortener, or a bare form ID.',
    'entryId is the prefill key: append ?entry.123456=value to the form URL.',
    'A form that only opens to a signed-in Google account answers 403 with requiresSignIn true.',
  ],
};

exports.handler = async (event) => {
  const route = (event.path || '')
    .replace(/^\/\.netlify\/functions\/api/, '')
    .replace(/^\/api/, '')
    .replace(/\/+$/, '');

  if ((event.httpMethod || 'GET') === 'OPTIONS') return json(204, null);
  if (route === '') return json(200, INDEX);
  if (route !== '/form') return json(404, { error: 'No such endpoint', endpoints: Object.keys(INDEX.endpoints) });

  // parse-form reads the same `url` query parameter and the same event (it
  // needs it to reach the blob cache), so it is handed straight through.
  const res = await parseForm.handler(event);
  let payload;
  try { payload = JSON.parse(res.body); } catch { return json(502, { error: 'Form parser gave nothing readable' }); }

  if (res.statusCode !== 200) {
    return json(res.statusCode, {
      error: payload.error || 'Could not read that form',
      ...(payload.formUrl ? { formUrl: payload.formUrl } : {}),
      ...(payload.requiresSignIn ? { requiresSignIn: true, reader: payload.reader } : {}),
    });
  }

  return json(200, {
    formId: payload.formId,
    formUrl: payload.formUrl,
    title: payload.formTitle || '',
    // True when the form only shows its questions to a signed-in Google
    // account — these were read through Accord's reader, and a person
    // opening the form still has to be signed in.
    requiresSignIn: !!payload.requiresSignIn,
    questions: (payload.fields || []).map(describe),
  });
};

/**
 * One question, in the shape this API promises.
 *
 * `emailAddress` is the key Google uses for the address box that the
 * "Collect email addresses" toggle adds; parse-form always offers it
 * because forms without collection ignore it silently, so it is named
 * here as what it is rather than left to look like a question the form
 * asked.
 */
function describe(f) {
  const q = {
    entryId: f.entryId,
    label: f.label || '',
    type: f.entryId === 'emailAddress' ? 'email' : (TYPE_NAMES[f.type] || 'short answer'),
  };
  if (f.required) q.required = true;
  if (Array.isArray(f.options)) q.options = f.options;
  // An "Other…" box on a choice question: whoever is filling it in is not
  // held to the listed options.
  if (f.hasOther) q.hasOther = true;
  if (f.row) q.row = f.row;
  return q;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // A form's questions change rarely; parse-form's own blob cache sits
      // behind this, and the edge keeps the answer warm for everyone else.
      'Cache-Control': statusCode === 200 ? 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' : 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
    body: body === null ? '' : JSON.stringify(body),
  };
}
