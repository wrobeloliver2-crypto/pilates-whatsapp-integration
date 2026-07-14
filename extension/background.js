// Hält immer nur EINEN WhatsApp-Web-Tab offen.
//
// Hintergrund (Oliver-Feedback 07/2026: "jedes Mal ein neues Fenster, am
// Ende dutzende WhatsApp-Tabs offen"): Das Lead-Dashboard öffnet bei jeder
// Übergabe ("An WhatsApp übergeben" / "Chat öffnen") web.whatsapp.com per
// window.open(). Eigentlich sollte ein benannter Fenster-Ziel-Trick denselben
// Tab wiederverwenden — das scheitert aber technisch: web.whatsapp.com
// schickt den Sicherheits-Header "Cross-Origin-Opener-Policy: same-origin".
// Sobald der Tab einmal geladen hat, kappt Chrome deshalb die Opener-
// Beziehung zum window.open()-Aufrufer (Browsing-Context-Group-Swap). Jede
// vom Dashboard gehaltene Fenster-Referenz meldet danach fälschlich
// `.closed === true` und lässt sich nicht mehr umlenken, fokussieren oder
// schließen — live per Browser-Automation nachgestellt und bestätigt
// (07/2026). Von einer normalen Webseite aus (Dashboard-JS) ist das NICHT
// reparierbar. Nur eine Extension hat über die privilegierte chrome.tabs-API
// noch Zugriff auf den Tab, weil sie nicht an diese Origin-Isolation
// gebunden ist — deshalb sitzt die eigentliche Lösung hier.
//
// Ansatz bewusst zustandslos (kein "letzter bekannter Tab" im Speicher):
// MV3-Service-Worker werden bei Inaktivität beendet und verlieren dabei
// jeden In-Memory-Zustand — ein gemerkter "kanonischer Tab" wäre nach einer
// Idle-Phase wieder weg. Stattdessen wird bei JEDER WhatsApp-URL-Änderung
// frisch nachgeschaut, wie viele WhatsApp-Tabs es gerade gibt: der älteste
// (kleinste Tab-ID = zuerst erstellt) bleibt bestehen und wird auf die neue
// Ziel-URL umgelenkt + fokussiert, alle jüngeren Duplikate werden geschlossen.
// Das greift unabhängig davon, ob ein Tab vom Dashboard oder manuell
// geöffnet wurde.

function istWhatsAppUrl(url) {
  return typeof url === 'string' && url.startsWith('https://web.whatsapp.com');
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !istWhatsAppUrl(changeInfo.url)) return;

  chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, (alle) => {
    if (chrome.runtime.lastError || !alle || alle.length <= 1) return;

    const sortiert = [...alle].sort((a, b) => a.id - b.id);
    const kanonisch = sortiert[0];
    const duplikate = sortiert.slice(1);

    // Falls DER Tab, dessen URL sich gerade geändert hat, eines der Duplikate
    // ist: seine Ziel-URL zuerst auf den kanonischen Tab übertragen, bevor
    // das Duplikat geschlossen wird — sonst geht die neue Adresse verloren.
    const geaendertesDuplikat = duplikate.find(t => t.id === tabId);
    if (geaendertesDuplikat) {
      chrome.tabs.update(kanonisch.id, { url: changeInfo.url, active: true });
      chrome.windows.update(kanonisch.windowId, { focused: true });
    }

    duplikate.forEach(t => {
      chrome.tabs.remove(t.id, () => { void chrome.runtime.lastError; });
    });
  });
});

// "Im Dashboard öffnen" (v1.2.2): content.js schickt hierher statt selbst
// window.open/target zu nutzen.
//
// v1.2.1 hatte noch auf <a target="pc_dashboard_tab"> gesetzt — das
// funktioniert NUR, wenn WIR den Tab beim ersten Klick selbst benannt haben.
// Olivers echter Ablauf (Screenshots 07/2026): er hat morgens schon einen
// Dashboard-Tab von Hand offen (URL eingetippt) — der trägt nie unseren
// Namen, der Browser kann ihn beim ersten "Im Dashboard öffnen"-Klick aus
// WhatsApp also nicht finden und öffnet zusätzlich einen neuen. Deshalb hier
// derselbe Ansatz wie beim WhatsApp-Tab-Merge oben: über chrome.tabs.query
// nach der TATSÄCHLICHEN URL suchen (findet auch von Hand geöffnete Tabs),
// den ältesten als kanonisch behandeln, umlenken + fokussieren, Duplikate
// schließen. Kein "_blank"/target-Trick mehr nötig.
const DASHBOARD_ORIGIN = 'https://pilatesleaddashboard.netlify.app';

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'openDashboard' || !msg.url) return;

  chrome.tabs.query({ url: `${DASHBOARD_ORIGIN}/*` }, (alle) => {
    if (chrome.runtime.lastError) return;

    if (!alle || alle.length === 0) {
      chrome.tabs.create({ url: msg.url });
      return;
    }

    const sortiert = [...alle].sort((a, b) => a.id - b.id);
    const kanonisch = sortiert[0];
    const duplikate = sortiert.slice(1);

    chrome.tabs.update(kanonisch.id, { url: msg.url, active: true });
    chrome.windows.update(kanonisch.windowId, { focused: true });

    // Etwaige Dashboard-Duplikate (z.B. aus der Zeit vor diesem Fix) gleich
    // mit aufräumen, statt sie ewig herumliegen zu lassen.
    duplikate.forEach(t => {
      chrome.tabs.remove(t.id, () => { void chrome.runtime.lastError; });
    });
  });
});
