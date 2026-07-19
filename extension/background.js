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

// ============================================================================
// Bulk-Sync (NEU, v1.3.0): "Pull"-Button im Dashboard → Verlauf ALLER aktiven
// Leads einmal automatisch abholen, statt pro Chat einzeln "Verlauf an KI
// senden" zu klicken.
//
// Warum das hier im Background-Service-Worker läuft (statt in content.js):
// jeder Kontaktwechsel per `web.whatsapp.com/send?phone=…` ist eine ECHTE
// Navigation (kompletter Reload von WhatsApp Web, kein SPA-Routing) — ein
// content.js-Script würde bei jedem Wechsel neu geladen und verlöre seinen
// Schleifenzustand. Der Background-Service-Worker dagegen ist ein eigener,
// von der Tab-Navigation unabhängiger Kontext: er stößt den nächsten
// Kontaktwechsel per chrome.tabs.update an, wartet auf den Ladeabschluss und
// bittet content.js (frisch geladen, kennt nur den EINEN aktuellen Chat) per
// Nachricht um den Verlauf dieses einen Chats. So bleibt die eigentliche
// Schleife robust gegen die Reloads.
//
// Bekannte Grenzen (erster Praxis-Test steht noch aus, live nicht testbar):
// - MV3-Service-Worker können nach ~30s ohne API-Aktivität beendet werden;
//   bei sehr vielen Leads könnte ein Lauf mittendrin abbrechen. Deshalb harte
//   Obergrenze MAX_LEADS_PRO_LAUF — im Zweifel Button einfach erneut klicken.
// - WhatsApp kann das DOM jederzeit ändern (siehe Verlauf der leseVerlauf-
//   Fallbacks in content.js) — Timeouts/Retries hier bewusst großzügig.

const DASHBOARD_API = `${DASHBOARD_ORIGIN}/.netlify/functions/sheets-api`;
const MAX_LEADS_PRO_LAUF = 40;
const TAB_LADE_TIMEOUT_MS = 15000;
const NACH_LADEN_PUFFER_MS = 2200;
const SCRAPE_TIMEOUT_MS = 9000;
const PAUSE_ZWISCHEN_CHATS_MS = 700;

let bulkSyncLaeuft = false;

// Identisch zur Logik in WhatsAppBuilder.jsx (waNummer) bzw. content.js
// (normalisiereTelefon) — bewusst hier dupliziert statt importiert, da
// MV3-Service-Worker ohne Bundler kein einfaches Modul-Sharing über
// Repo-Grenzen (Dashboard ↔ Extension) erlauben.
function waInternational(tel = '') {
  let d = String(tel).replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('0049')) d = '49' + d.slice(4);
  else if (d.startsWith('49')) { /* schon international */ }
  else if (d.startsWith('0')) d = '49' + d.slice(1);
  else if (d.length <= 11) d = '49' + d;
  return d;
}

function normalisiereTelefonBg(t = '') {
  let d = String(t).replace(/[^\d]/g, '');
  if (d.startsWith('0049')) d = d.slice(4);
  else if (d.startsWith('49') && d.length > 10) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

function warte(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// An alle offenen Dashboard-Tabs senden (nicht nur den, der den Sync
// gestartet hat) — robuster als sich eine Tab-ID über die Laufzeit zu
// merken, falls der Service-Worker zwischendurch neu startet.
function sendeAnDashboard(msg) {
  chrome.tabs.query({ url: `${DASHBOARD_ORIGIN}/*` }, (alle) => {
    if (chrome.runtime.lastError || !alle) return;
    alle.forEach(t => {
      chrome.tabs.sendMessage(t.id, msg, () => { void chrome.runtime.lastError; });
    });
  });
}

// Genau einen WhatsApp-Web-Tab sicherstellen (reuse der bestehenden
// Single-Tab-Logik oben: existiert schon einer, wird der älteste genutzt).
async function stelleWhatsAppTabSicher() {
  const alle = await new Promise(resolve =>
    chrome.tabs.query({ url: 'https://web.whatsapp.com/*' }, resolve)
  );
  if (alle && alle.length) {
    const aeltester = [...alle].sort((a, b) => a.id - b.id)[0];
    return aeltester.id;
  }
  const neu = await new Promise(resolve =>
    chrome.tabs.create({ url: 'https://web.whatsapp.com/', active: true }, resolve)
  );
  // Frisch erstellter Tab braucht Zeit für Login/Socket-Aufbau, bevor der
  // erste Kontaktwechsel Sinn ergibt.
  await warteAufTabFertig(neu.id, TAB_LADE_TIMEOUT_MS);
  await warte(3000);
  return neu.id;
}

function warteAufTabFertig(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let erledigt = false;
    const fertig = () => {
      if (erledigt) return;
      erledigt = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') fertig();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Tab war evtl. schon fertig, bevor der Listener registriert wurde.
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === 'complete') fertig();
    });
    setTimeout(fertig, timeoutMs);
  });
}

function bitteUmScrape(tabId, erwarteteNummer, chatName) {
  return new Promise((resolve) => {
    let erledigt = false;
    const timeout = setTimeout(() => {
      if (erledigt) return;
      erledigt = true;
      resolve({ ok: false, reason: 'Zeitüberschreitung — Chat evtl. nicht geladen' });
    }, SCRAPE_TIMEOUT_MS);
    chrome.tabs.sendMessage(tabId, { type: 'scrapeAndSend', erwarteteNummer, chatName }, (antwort) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(timeout);
      if (chrome.runtime.lastError || !antwort) {
        resolve({ ok: false, reason: chrome.runtime.lastError?.message || 'Keine Antwort von content.js' });
        return;
      }
      resolve(antwort);
    });
  });
}

async function starteBulkSync() {
  if (bulkSyncLaeuft) return; // kein doppelter Lauf, falls der Button zweimal klickt
  bulkSyncLaeuft = true;

  const ergebnis = { total: 0, erfolgreich: 0, fehlgeschlagen: 0, uebersprungenLimit: 0 };
  let tabId = null;

  const beenden = (extra = {}) => {
    const fertig = { type: 'bulkSyncDone', ...ergebnis, ...extra };
    sendeAnDashboard(fertig);
    if (tabId != null) chrome.tabs.sendMessage(tabId, fertig, () => { void chrome.runtime.lastError; });
    bulkSyncLaeuft = false;
  };

  try {
    const res = await fetch(DASHBOARD_API, {
      method: 'POST',
      body: JSON.stringify({ action: 'getAll' }),
    });
    const leads = await res.json();
    if (!Array.isArray(leads)) throw new Error('Dashboard-Antwort war keine Lead-Liste');

    // Nur aktive Leads mit Telefonnummer — "Erledigt" braucht keinen frischen
    // Verlauf mehr (gleiche Philosophie wie "Dashboard = nur aktive Leads").
    const kandidaten = leads.filter(l => l.telefon && l.status !== 'Erledigt');
    ergebnis.uebersprungenLimit = Math.max(0, kandidaten.length - MAX_LEADS_PRO_LAUF);
    const zuSynchen = kandidaten.slice(0, MAX_LEADS_PRO_LAUF);
    ergebnis.total = zuSynchen.length;

    if (!zuSynchen.length) { beenden(); return; }

    tabId = await stelleWhatsAppTabSicher();

    for (let i = 0; i < zuSynchen.length; i++) {
      const lead = zuSynchen[i];
      const fortschritt = { type: 'bulkSyncProgress', done: i, total: zuSynchen.length, name: lead.name || '' };
      sendeAnDashboard(fortschritt);
      chrome.tabs.sendMessage(tabId, fortschritt, () => { void chrome.runtime.lastError; }); // Banner im WA-Tab

      const intl = waInternational(lead.telefon);
      const nummerNorm = normalisiereTelefonBg(lead.telefon);
      if (!intl || !nummerNorm) { ergebnis.fehlgeschlagen++; continue; }

      chrome.tabs.update(tabId, { url: `https://web.whatsapp.com/send?phone=${intl}` });
      await warteAufTabFertig(tabId, TAB_LADE_TIMEOUT_MS);
      await warte(NACH_LADEN_PUFFER_MS);

      const antwort = await bitteUmScrape(tabId, nummerNorm, lead.name || '');
      if (antwort && antwort.ok) ergebnis.erfolgreich++; else ergebnis.fehlgeschlagen++;

      await warte(PAUSE_ZWISCHEN_CHATS_MS);
    }
  } catch (err) {
    beenden({ fehler: err.message });
    return;
  }

  beenden();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'startBulkSync') return;
  starteBulkSync();
});
