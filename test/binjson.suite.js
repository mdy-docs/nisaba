/**
 * Wire up OPFS for Node via node-opfs (or detect native browser OPFS).
 * Returns { hasOPFS } so file-backed tests can skip when unavailable.
 */
export async function bootstrapOPFS() {
  let hasOPFS = false;
  try {
    const nodeOpfs = await import('node-opfs');
    if (nodeOpfs.navigator && typeof global !== 'undefined') {
      Object.defineProperty(global, 'navigator', {
        value: nodeOpfs.navigator,
        writable: true,
        configurable: true
      });
      hasOPFS = true;
    }
  } catch (e) {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
      hasOPFS = true;
    }
  }
  return { hasOPFS };
}
