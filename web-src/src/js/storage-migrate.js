// Auduio was called WebDAW before v0.3.1. Copy settings saved under the old localStorage keys to the new
// ones (old keys are left in place, so nothing is lost). Imported first by every module that uses storage.
const KEYS = ['prefs', 'tier', 'pin', 'rackPresets'];
try {
  for (const k of KEYS) {
    const nk = 'auduio.' + k, ok = 'webdaw.' + k;
    if (localStorage.getItem(nk) == null && localStorage.getItem(ok) != null) localStorage.setItem(nk, localStorage.getItem(ok));
  }
} catch (e) { /* storage unavailable (private mode): nothing to migrate */ }
export const STORAGE_PREFIX = 'auduio.';
