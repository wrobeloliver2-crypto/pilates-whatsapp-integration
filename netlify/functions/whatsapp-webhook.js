const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PHONE_NUMBER_TO_USER = {
  [process.env.OLIVER_WA_PHONE_NUMBER_ID]: {
    name: "Oliver Wrobel",
    email: process.env.OLIVER_HUBSPOT_OWNER_EMAIL,
    accessToken: process.env.OLIVER_WA_ACCESS_TOKEN,
  },
};

const messageCache = {};

function addToCache(phone, message) {
  if (!messageCache[phone]) messageCache[phone] = [];
  messageCache[phone].push(message);
  if (messageCache[phone].length > 20) {
    messageCache[phone] = messageCache[phone].slice(-20);
  }
}

async function getOwnerId(ownerEmail, headers) {
  try {
    const res = await axios.get("https://api.hubapi.com/crm/v3/owners", { headers });
    const owner = res.data.results.find((o) => o.email === ownerEmail);
    return owner ? owner.id : null;
  } catch (err) {
    return null;
  }
}

async function findOrCreateContact(phone, ownerEmail) {
  const headers = {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json",
  };
  const formattedPhone = "+" + phone;
  try {
    const searchRes = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      { filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: formattedPhone }] }], properties: ["firstname", "lastname", "email", "phone"] },
      { headers }
    );
    if (searchRes.data.results.length > 0) return searchRes.data.results[0];
  } catch (err) {}
  const ownerId = await getOwnerId(ownerEmail, headers);
  const createRes = await axios.post(
    "https://api.hubapi.com/crm/v3/objects/contacts",
    { properties: { phone: formattedPhone, firstname: "WhatsApp Kunde", lastname: formattedPhone, lifecyclestage: "lead", ...(ownerId && { hubspot_owner_id: ownerId }) } },
    { headers }
  );
  return createRes.data;
}

async function analyzeChat(messages) {
  const chatText = messages.map((m) => `${m.from === "business" ? "Pilates Company" : "Kunde"}: ${m.text}`).join("\n");
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: `Du bist Assistent für Pilates Company Lübeck. Analysiere diesen WhatsApp-Chat und antworte NUR mit JSON:\n\nCHAT:\n${chatText}\n\n{"zusammenfassung":"...","anfrage_typ":"Probetraining|Kurs-Anfrage|Zahlung|Termin|Frage|Sonstiges","aktion_erforderlich":true,"aktion_beschreibung":"...","prioritaet":"HOCH|NORMAL|NIEDRIG","naechster_schritt":"..."}` }],
  });
  return JSON.parse(response.content[0].text.trim().replace(/```json|```/g, "").trim());
}

async function saveActivity(contactId, analysis, ownerName, ownerEmail, messages) {
  const headers = { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`, "Content-Type": "application/json" };
  const ownerId = await getOwnerId(ownerEmail, headers);
  const body = `📱 WhatsApp Chat Zusammenfassung\n━━━━━━━━━━━━━━━━━━━━━━━\n${analysis.zusammenfassung}\n\n📋 Anfrage-Typ: ${analysis.anfrage_typ}\n🎯 Nächster Schritt: ${analysis.naechster_schritt}\n━━━━━━━━━━━━━━━━━━━━━━━\n💬 ${messages.length} Nachrichten | Von: ${ownerName}`;
  await axios.post("https://api.hubapi.com/crm/v3/objects/notes", { properties: { hs_note_body: body, hs_timestamp: new Date().toISOString(), ...(ownerId && { hubspot_owner_id: ownerId }) }, associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] }, { headers });
}

async function createTodo(contactId, analysis, ownerEmail, phone) {
  if (!analysis.aktion_erforderlich) return null;
  const headers = { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`, "Content-Type": "application/json" };
  const ownerId = await getOwnerId(ownerEmail, headers);
  const dueDate = new Date();
  dueDate.setHours(dueDate.getHours() + 1);
  await axios.post("https://api.hubapi.com/crm/v3/objects/tasks", { properties: { hs_task_subject: `📱 WhatsApp: ${analysis.aktion_beschreibung}`, hs_task_body: `${analysis.aktion_beschreibung}\n\nNächster Schritt: ${analysis.naechster_schritt}\n\n👉 WhatsApp: https://wa.me/${phone}`, hs_timestamp: dueDate.toISOString(), hs_task_status: "NOT_STARTED", hs_task_priority: analysis.prioritaet === "HOCH" ? "HIGH" : "MEDIUM", ...(ownerId && { hubspot_owner_id: ownerId }) }, associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }] }] }, { headers });
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const p = event.queryStringParameters || {};
    if (p["hub.mode"] === "subscribe" && p["hub.verify_token"] === process.env.WA_VERIFY_TOKEN) {
      return { statusCode: 200, body: p["hub.challenge"] };
    }
    return { statusCode: 403, body: "Forbidden" };
  }
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body);
      const value = body?.entry?.[0]?.changes?.[0]?.value;
      if (!value?.messages) return { statusCode: 200, body: "OK" };
      const user = PHONE_NUMBER_TO_USER[value.metadata?.phone_number_id];
      if (!user) return { statusCode: 200, body: "OK" };
      for (const message of value.messages) {
        if (message.type !== "text") continue;
        const phone = message.from;
        const text = message.text?.body || "";
        addToCache(phone, { from: "customer", text, timestamp: new Date() });
        const contact = await findOrCreateContact(phone, user.email);
        const msgs = messageCache[phone] || [{ from: "customer", text }];
        const analysis = await analyzeChat(msgs);
        await saveActivity(contact.id, analysis, user.name, user.email, msgs);
        await createTodo(contact.id, analysis, user.email, phone);
      }
      return { statusCode: 200, body: JSON.stringify({ status: "OK" }) };
    } catch (err) {
      return { statusCode: 500, body: err.message };
    }
  }
  return { statusCode: 405, body: "Method Not Allowed" };
};
