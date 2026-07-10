// Pilates Company – Lead-Sidebar für WhatsApp Web
// Erkennt die Telefonnummer des aktiven 1:1-Chats und zeigt rechts oben die
// passende Karte aus dem Lead-Dashboard (Google Sheet via sheets-api).
//
// Nummern-Erkennung: WhatsApp Web trägt an jeder Nachrichtenzeile ein
// data-id wie "false_4917661280122@c.us_ABC…" — daraus lesen wir die JID.
// Gruppen (@g.us) werden ignoriert. Fallback: Header-Text, falls der
// Kontakt unter seiner Nummer (nicht gespeichert) angezeigt wird.

const API = 'https://pilatesleaddashboard.netlify.app/.netlify/functions/sheets-api';
const TRANSCRIPT_API = 'https://pilatesleaddashboard.netlify.app/.netlify/functions/wa-transcript';
const DASHBOARD_URL = 'https://pilatesleaddashboard.netlify.app';
const CACHE_MS = 60 * 1000; // Leads höchstens einmal pro Minute neu laden

// ---- Verlauf des aktiven Chats auslesen ----
// WhatsApp Web: jede Nachrichtenzeile hat data-id "true_…" (von uns) bzw.
// "false_…" (vom Kontakt); der Container mit data-pre-plain-text trägt
// "[HH:mm, TT.MM.JJJJ] Name: " — daraus lesen wir den Zeitstempel.
// Nur Textnachrichten; Bilder/Sprachnachrichten ohne Text werden übersprungen.
// HINWEIS: DOM-abhängig — deshalb MEHRSTUFIGE Fallbacks (WhatsApp ändert
// gelegentlich Klassen/Attribute; Stand 07/2026 fand `selectable-text`
// keine Treffer mehr, obwohl die data-id-Zeilen weiterhin existieren):
//   Zeilen:  data-id-Prefix → Fallback CSS-Klassen message-in/message-out
//   Text:    selectable-text → copyable-text-Container → Zeilentext (bereinigt)
// Diagnose: console.debug '[PC-Sidebar] …' zeigt, welche Stufe gegriffen hat.
const SIDEBAR_VERSION = '1.1.4';

// Letzte Verlaufs-Diagnose — wird bei leerem Ergebnis direkt im Panel angezeigt,
// damit die Fehlersuche ohne Entwicklerkonsole möglich ist.
let letzteVerlaufDiagnose = '';

function textAusZeile(row) {
  // Stufe 1: klassischer Text-Span
  let el = row.querySelector('span.selectable-text, div.selectable-text');
  if (el && (el.innerText || '').trim()) return { text: el.innerText.trim(), stufe: 'selectable-text' };
  // Stufe 2: copyable-text-Container (trägt data-pre-plain-text); dessen
  // innerText enthält den reinen Nachrichtentext (Zeitstempel steckt im Attribut)
  el = row.querySelector('[data-pre-plain-text]');
  if (el && (el.innerText || '').trim()) return { text: el.innerText.trim(), stufe: 'pre-plain-text' };
  // Stufe 3 (Notnagel): kompletter Zeilentext, Uhrzeit-Suffix ("10:42" o. Ä.)
  // am Ende entfernen. Kann Metadaten enthalten — für den KI-Kontext akzeptabel.
  const roh = (row.innerText || '').trim();
  const bereinigt = roh.replace(/\n?\d{1,2}:\d{2}(\s?(AM|PM))?\s*$/i, '').trim();
  if (bereinigt) return { text: bereinigt, stufe: 'zeilentext' };
  return { text: '', stufe: 'leer' };
}

function leseVerlauf(maxN = 20) {
  const main = document.querySelector('#main');
  if (!main) {
    letzteVerlaufDiagnose = '#main nicht gefunden (Chat-Container fehlt)';
    console.debug('[PC-Sidebar] Verlauf: #main nicht gefunden');
    return [];
  }
  // Zeilen-Erkennung Stufe 1: data-id ENTHÄLT @c.us — derselbe Selektor, mit dem
  // auch die (nachweislich funktionierende) Nummern-Erkennung arbeitet.
  // Stand 07/2026: die IDs beginnen NICHT mehr mit "true_/false_" (Präfix-Selektor
  // fand 0 Zeilen), true/false steckt aber weiterhin IN der ID → includes().
  let rows = Array.from(main.querySelectorAll('[data-id*="@c.us"]'));
  let zeilenQuelle = 'data-id-contains';
  // Stufe 2: Richtungs-Klassen OHNE Tag-Einschränkung (div.… griff nicht mehr)
  if (!rows.length) {
    rows = Array.from(main.querySelectorAll('.message-in, .message-out'));
    zeilenQuelle = 'message-klassen';
  }
  // Stufe 3: generische Nachrichten-Zeilen der Chatliste
  if (!rows.length) {
    rows = Array.from(main.querySelectorAll('[role="row"]'));
    zeilenQuelle = 'role-row';
  }
  // Verschachtelte Treffer aussortieren (Container, die selbst wieder einen
  // Treffer enthalten, würden Texte doppelt erfassen) → nur innerste behalten.
  if (rows.length > 1) {
    rows = rows.filter(r => !rows.some(other => other !== r && r.contains(other)));
  }
  const msgs = [];
  const stufenZaehler = {};
  rows.forEach(row => {
    const id = row.getAttribute('data-id') || '';
    // Richtung: true/false irgendwo in der ID; sonst über Richtungs-Klassen
    // am Element selbst oder in Kind-/Elternknoten; sonst unbekannt.
    let von;
    if (id.includes('true_')) von = 'Studio';
    else if (id.includes('false_')) von = 'Kunde';
    else if (row.classList.contains('message-out') || row.closest('.message-out') || row.querySelector('.message-out')) von = 'Studio';
    else if (row.classList.contains('message-in') || row.closest('.message-in') || row.querySelector('.message-in')) von = 'Kunde';
    else von = 'Unbekannt';
    const pre = row.querySelector('[data-pre-plain-text]');
    const zeit = pre ? ((pre.getAttribute('data-pre-plain-text') || '').match(/\[(.*?)\]/) || [, ''])[1] : '';
    const { text, stufe } = textAusZeile(row);
    stufenZaehler[stufe] = (stufenZaehler[stufe] || 0) + 1;
    if (text) msgs.push({ von, zeit, text: text.slice(0, 600) });
  });
  const stufenText = Object.entries(stufenZaehler).map(([k, v]) => `${k}=${v}`).join(', ')
  letzteVerlaufDiagnose = `${rows.length} Zeilen (${zeilenQuelle}), ${msgs.length} Texte [${stufenText}]`;
  console.debug(`[PC-Sidebar] Verlauf: ${letzteVerlaufDiagnose}`);
  return msgs.slice(-maxN);
}

async function sendeVerlauf(nummerNorm, chatName, statusEl) {
  const nachrichten = leseVerlauf();
  if (!nachrichten.length) {
    statusEl.textContent = `Keine Texte gefunden — v${SIDEBAR_VERSION}: ${letzteVerlaufDiagnose}`;
    return;
  }
  statusEl.textContent = '⏳ sende …';
  try {
    const res = await fetch(TRANSCRIPT_API, {
      method: 'POST',
      body: JSON.stringify({ telefon: nummerNorm, chatName, nachrichten }),
    });
    const data = await res.json();
    statusEl.textContent = data.ok
      ? `✓ ${data.anzahl} Nachrichten übermittelt — KI-Vorschlag nutzt sie jetzt`
      : `⚠ ${data.reason || 'Fehler'}`;
  } catch {
    statusEl.textContent = '⚠ Dashboard nicht erreichbar';
  }
}

let leadsCache = { at: 0, leads: [] };
let aktuelleNummer = null;
let panelEingeklappt = false;

// ---- Telefon-Normalisierung (identisch zur Dashboard-Logik in evs-intake) ----
function normalisiereTelefon(t = '') {
  let d = String(t).replace(/[^\d]/g, '');
  if (d.startsWith('0049')) d = d.slice(4);
  else if (d.startsWith('49') && d.length > 10) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

// ---- Nummer des aktiven Chats ermitteln ----
function leseChatNummer() {
  const main = document.querySelector('#main');
  if (!main) return null;

  // 1) data-id an Nachrichtenzeilen: "…_<nummer>@c.us_…"
  const mitId = main.querySelector('[data-id*="@c.us"]');
  if (mitId) {
    const m = (mitId.getAttribute('data-id') || '').match(/(\d{6,})@c\.us/);
    if (m) return m[1];
  }
  // Gruppe? Dann bewusst nichts anzeigen.
  if (main.querySelector('[data-id*="@g.us"]')) return null;

  // 2) Fallback: Header zeigt bei ungespeicherten Kontakten die Nummer
  const header = main.querySelector('header');
  if (header) {
    const m = (header.textContent || '').match(/\+?[\d\s\-()]{8,}/);
    if (m && normalisiereTelefon(m[0]).length >= 6) return normalisiereTelefon(m[0]);
  }
  return null;
}

// ---- Leads vom Dashboard laden (mit kleinem Cache) ----
async function holeLeads() {
  if (Date.now() - leadsCache.at < CACHE_MS && leadsCache.leads.length) return leadsCache.leads;
  const res = await fetch(API, { method: 'POST', body: JSON.stringify({ action: 'getAll' }) });
  const data = await res.json();
  if (Array.isArray(data)) leadsCache = { at: Date.now(), leads: data };
  return leadsCache.leads;
}

function findeLead(leads, nummerNorm) {
  return leads.find(l => normalisiereTelefon(l.telefon || '') === nummerNorm) || null;
}

// ---- Alter formatieren: "2 T 5 Std" / "5 Std" / "12 Min" ----
function alterText(ts) {
  if (!ts) return null;
  const iso = ts.trim().slice(0, 16).replace(' ', 'T');
  const d = new Date(iso.length === 10 ? iso + 'T00:00' : iso);
  if (isNaN(d)) return null;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return null;
  const stdGesamt = Math.floor(diff / 36e5);
  const tage = Math.floor(stdGesamt / 24);
  if (tage > 0) return `${tage} T ${stdGesamt % 24} Std`;
  if (stdGesamt > 0) return `${stdGesamt} Std`;
  return `${Math.max(1, Math.floor(diff / 6e4))} Min`;
}

function esc(s = '') {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ---- Panel ----
function panelElement() {
  let el = document.getElementById('pc-lead-panel');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'pc-lead-panel';
  document.body.appendChild(el);
  return el;
}

function renderPanel(inhaltHtml, titel) {
  const el = panelElement();
  el.innerHTML = `
    <div class="pc-kopf">
      <span class="pc-titel">${esc(titel)}</span>
      <button class="pc-toggle" title="Ein-/ausklappen">${panelEingeklappt ? '▸' : '▾'}</button>
    </div>
    <div class="pc-inhalt" style="${panelEingeklappt ? 'display:none' : ''}">${inhaltHtml}</div>
  `;
  el.querySelector('.pc-toggle').addEventListener('click', () => {
    panelEingeklappt = !panelEingeklappt;
    const inhalt = el.querySelector('.pc-inhalt');
    inhalt.style.display = panelEingeklappt ? 'none' : '';
    el.querySelector('.pc-toggle').textContent = panelEingeklappt ? '▸' : '▾';
  });
}

function zeile(label, wert, klasse = '') {
  if (!wert) return '';
  return `<div class="pc-zeile ${klasse}"><span class="pc-label">${esc(label)}</span><span class="pc-wert">${esc(wert)}</span></div>`;
}

function renderLead(lead) {
  const wa = alterText(lead.waGesendetAm);
  const wv = lead.wiedervorlage ? lead.wiedervorlage.slice(0, 16).replace('T', ' ') : '';
  // Interner De-Dup-Zähler "[Buchungen: N]" aus den Notizen: für die Anzeige
  // herauslösen — nur ab 2 Buchungen als eigene Zeile relevant (Wiederholtäter),
  // bei 1 reine Technik ohne Informationswert.
  const notizenRoh = lead.notizen || '';
  const buchungenMatch = notizenRoh.match(/\[Buchungen:\s*(\d+)\]/);
  const buchungen = buchungenMatch ? parseInt(buchungenMatch[1], 10) : 0;
  const notizenAnzeige = notizenRoh.replace(/\s*\[Buchungen:\s*\d+\]\s*/g, ' ').trim();
  const html = `
    ${lead.quelle ? `<span class="pc-badge pc-quelle">${esc(lead.quelle)}</span>` : ''}
    ${lead.status ? `<span class="pc-badge pc-status">${esc(lead.status)}</span>` : ''}
    ${lead.prioritaet === 'Sofort' ? `<span class="pc-badge pc-sofort">SOFORT</span>` : ''}
    ${wa ? `<span class="pc-badge pc-wa">✓ WhatsApp · vor ${esc(wa)}</span>` : ''}
    ${zeile('Bearbeiter', lead.bearbeiter !== 'Unzugewiesen' ? lead.bearbeiter : '')}
    ${zeile('Interesse', lead.interesse)}
    ${zeile('Wunschtag', lead.wunschtag)}
    ${buchungen >= 2 ? zeile('Buchungen', `${buchungen}× (Mehrfach-Bucher)`) : ''}
    ${zeile('Wiedervorlage', wv && lead.wiedervorlageGrund ? `${wv} — ${lead.wiedervorlageGrund}` : wv)}
    ${zeile('E-Mail', lead.email)}
    ${zeile('Eingang', lead.eingangsdatum)}
    ${lead.nachricht ? `<div class="pc-nachricht">„${esc(lead.nachricht)}"</div>` : ''}
    ${notizenAnzeige ? `<div class="pc-notizen">${esc(notizenAnzeige)}</div>` : ''}
    <button class="pc-verlauf-btn" type="button">⤴ Verlauf an KI senden</button>
    <div class="pc-verlauf-status"></div>
    <a class="pc-link" href="${DASHBOARD_URL}${lead.id ? `?lead=${encodeURIComponent(lead.id)}` : ''}" target="_blank" rel="noopener">Im Dashboard öffnen ↗</a>
  `;
  renderPanel(html, lead.name || '(kein Name)');
  const el = document.getElementById('pc-lead-panel');
  const btn = el.querySelector('.pc-verlauf-btn');
  const statusEl = el.querySelector('.pc-verlauf-status');
  if (btn) btn.addEventListener('click', () => sendeVerlauf(aktuelleNummer, lead.name || '', statusEl));
}

function renderKeinLead(nummerNorm) {
  renderPanel(
    `<div class="pc-leer">Kein Lead zu dieser Nummer<br><span class="pc-nummer">0${esc(nummerNorm)}</span></div>
     <a class="pc-link" href="${DASHBOARD_URL}" target="_blank" rel="noopener">Dashboard öffnen ↗</a>`,
    'Lead-Dashboard'
  );
}

function entfernePanel() {
  const el = document.getElementById('pc-lead-panel');
  if (el) el.remove();
  aktuelleNummer = null;
}

// ---- Hauptschleife: auf Chat-Wechsel reagieren ----
let debounceTimer = null;
async function pruefeChat() {
  const roh = leseChatNummer();
  if (!roh) { entfernePanel(); return; }
  const nummerNorm = normalisiereTelefon(roh);
  if (nummerNorm === aktuelleNummer) return; // gleicher Chat, nichts zu tun
  aktuelleNummer = nummerNorm;

  try {
    const leads = await holeLeads();
    // Chat könnte inzwischen gewechselt haben
    if (aktuelleNummer !== nummerNorm) return;
    const lead = findeLead(leads, nummerNorm);
    if (lead) renderLead(lead);
    else renderKeinLead(nummerNorm);
  } catch (e) {
    renderPanel(`<div class="pc-leer">Dashboard nicht erreichbar</div>`, 'Lead-Dashboard');
  }
}

const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(pruefeChat, 400);
});
observer.observe(document.body, { childList: true, subtree: true });
setTimeout(pruefeChat, 1500);
