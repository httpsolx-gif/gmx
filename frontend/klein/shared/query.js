/** Lead id from `?id=` (Klein flow pages). */
export function getLeadIdFromUrl() {
  try {
    var m = /[?&]id=([^&]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  } catch (e) {
    return '';
  }
}
