'use strict';

// In-memory cache for presigned R2 URLs.
// Entries expire 5 minutes before the URL's actual R2 expiry so clients always
// receive a URL with meaningful time left.

const SAFETY_MARGIN_MS = 5 * 60_000;

const _cache = new Map(); // key → { url, expiresAt }

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of _cache) {
    if (e.expiresAt <= now) _cache.delete(k);
  }
}, 10 * 60_000).unref();

function getCached(key) {
  const e = _cache.get(key);
  return (e && e.expiresAt > Date.now()) ? e.url : null;
}

function setCached(key, url, urlExpirySeconds) {
  const expiresAt = Date.now() + urlExpirySeconds * 1000 - SAFETY_MARGIN_MS;
  if (expiresAt > Date.now()) _cache.set(key, { url, expiresAt });
}

function invalidate(key) {
  _cache.delete(key);
}

module.exports = { getCached, setCached, invalidate };
