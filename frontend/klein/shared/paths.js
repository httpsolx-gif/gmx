export function isKleinAnmeldenPath() {
  try {
    const p = (window.location.pathname || '').replace(/\/$/, '').toLowerCase();
    return p === '/klein-anmelden';
  } catch (e) {
    return false;
  }
}
