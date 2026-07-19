// dashboard-bridge.js (NEU, v1.3.0)
//
// Läuft mit Extension-Rechten auf der Dashboard-Seite selbst (zusätzlicher
// content_scripts-Eintrag in manifest.json). Grund: die Dashboard-Seite ist
// eine ganz normale Webseite und hat KEINEN Zugriff auf web.whatsapp.com
// (andere Origin) — nur eine Extension darf über chrome.tabs/chrome.runtime
// zwischen beiden Seiten vermitteln. Dieses Script ist die Bruecke:
//
//   Dashboard-JS  --CustomEvent-->  dashboard-bridge.js  --chrome.runtime-->
//   background.js  --chrome.tabs.sendMessage-->  content.js (auf WhatsApp Web)
//
// und in der Gegenrichtung für Fortschritts-Meldungen genauso zurück.
// CustomEvents auf window funktionieren hier, weil Content-Scripts zwar ein
// isoliertes JS liegt aber DASSELBE DOM/window-Objekt teilen wie die Seite —
// window.dispatchEvent() aus dem React-Code kommt hier also an.

// ---- Ping/Pong: Dashboard kann prüfen, ob die Extension überhaupt läuft
// (z.B. um den Pull-Button auszugrauen / einen Hinweis zu zeigen, statt
// stumm nichts zu tun, wenn die Extension nicht installiert/aktiv ist). ----
window.addEventListener('pc-bridge-ping', () => {
  window.dispatchEvent(new CustomEvent('pc-bridge-pong'));
});

// ---- Dashboard → Extension: Bulk-Sync anstoßen ----
window.addEventListener('pc-start-bulk-sync', () => {
  chrome.runtime.sendMessage({ type: 'startBulkSync' });
});

// ---- Extension → Dashboard: Fortschritt/Ergebnis der WhatsApp-Extension
// als CustomEvents an die Seite weiterreichen, damit App.jsx sie mit einem
// normalen window.addEventListener empfangen kann. ----
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'bulkSyncProgress') {
    window.dispatchEvent(new CustomEvent('pc-bulk-sync-progress', { detail: msg }));
  } else if (msg.type === 'bulkSyncDone') {
    window.dispatchEvent(new CustomEvent('pc-bulk-sync-done', { detail: msg }));
  }
});
