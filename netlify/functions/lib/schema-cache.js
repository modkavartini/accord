// Cross-user schema cache: the first visitor to a form pays the parse cost
// (and, for sign-in-walled forms, the Pi round-trip); everyone after gets it
// straight from here. Keyed by formId in a Netlify Blob so it persists across
// deploys, regions and the edge cache's own eviction.
const { getStore, connectLambda } = require('@netlify/blobs');

const STORE   = 'schemas';
const MAX_AGE = 7 * 24 * 3600 * 1000;   // 7 days — forms rarely change their fields

function store(event) {
  if (event) { try { connectLambda(event); } catch (_) {} }
  return getStore({ name: STORE });
}

async function getCachedSchema(event, formId) {
  if (!formId) return null;
  try {
    const v = await store(event).get(`schema/${formId}`, { type: 'json' });
    if (v && v.savedAt && Date.now() - Date.parse(v.savedAt) < MAX_AGE) return v.payload;
  } catch (_) {}
  return null;
}

async function putCachedSchema(event, formId, payload) {
  if (!formId) return;
  try { await store(event).setJSON(`schema/${formId}`, { savedAt: new Date().toISOString(), payload }); }
  catch (_) {}
}

module.exports = { getCachedSchema, putCachedSchema };
