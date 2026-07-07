# Lead-Sidebar für WhatsApp Web

Chrome-Extension: Zeigt zur Telefonnummer des aktiven WhatsApp-Chats die
passende Karte aus dem Pilates Lead-Dashboard (rechts oben eingeblendet).

## Installation (einmalig)
1. Chrome → `chrome://extensions` öffnen
2. Oben rechts **Entwicklermodus** aktivieren
3. **„Entpackte Erweiterung laden"** → diesen Ordner (`extension/`) auswählen
4. web.whatsapp.com neu laden

## Nach Code-Updates
`chrome://extensions` → ↻-Symbol an der Extension → WhatsApp-Tab neu laden.

## Was sie zeigt
- Name, Quelle, Status, Priorität, Bearbeiter
- Interesse, Wunschtag, Wiedervorlage, E-Mail, Eingang
- WhatsApp-Versand-Pille mit Alter („✓ WhatsApp · vor 2 T 5 Std")
- Anfrage-Nachricht und Notizen
- Link ins Dashboard

## Verhalten
- Nummer wird aus dem aktiven 1:1-Chat gelesen (Gruppen werden ignoriert)
- Abgleich per normalisierter Telefonnummer gegen das Live-Sheet
- Leads werden max. 1×/Minute vom Dashboard geladen (Cache)
- Kein Lead zur Nummer → Panel zeigt „Kein Lead zu dieser Nummer"
- Panel ist per ▾/▸ einklappbar
