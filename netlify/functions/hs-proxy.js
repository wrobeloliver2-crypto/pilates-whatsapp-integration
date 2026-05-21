const HUBSPOT_TOKEN = process.env.HUBSPOT_PERSONAL_TOKEN;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };
  try {
    const { phone } = JSON.parse(event.body);
    const digits = phone.replace(/\D/g, "");
    
    // Normalisieren: immer auf lokale 10-stellige Nummer bringen
    let local;
    if (digits.startsWith("49") && digits.length > 10) {
      local = digits.slice(2); // 4917661280122 -> 17661280122
    } else if (digits.startsWith("0")) {
      local = digits.slice(1); // 017661280122 -> 17661280122
    } else {
      local = digits; // 17661280122
    }
    
    // Max 5 filterGroups, je 2 filter (phone + mobilephone) = 5 Varianten
    const variants = [
      "0" + local,           // 017661280122
      "+49" + local,         // +4917661280122
      "+49 " + local.slice(0,3) + " " + local.slice(3,7) + " " + local.slice(7), // +49 176 6128 0122
      "+49 " + local.slice(0,4) + " " + local.slice(4), // +49 1766 1280122
      "49" + local,          // 4917661280122
    ];
    
    const filterGroups = variants.map(v => ({
      filters: [
        { propertyName: "phone", operator: "EQ", value: v },
        { propertyName: "mobilephone", operator: "EQ", value: v }
      ]
    }));

    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filterGroups, properties: ["firstname","lastname","email","phone","mobilephone","lifecyclestage","hubspot_owner_id","notes_last_updated"] }),
    });
    const searchData = await searchRes.json();
    
    if (!searchData.results || searchData.results.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
    }
    const contact = searchData.results[0];
    const props = contact.properties;
    let ownerName = "Nicht zugewiesen";
    if (props.hubspot_owner_id) {
      try {
        const ownerRes = await fetch(`https://api.hubapi.com/crm/v3/owners/${props.hubspot_owner_id}`, {
          headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
        });
        const owner = await ownerRes.json();
        ownerName = `${owner.firstName} ${owner.lastName}`;
      } catch (e) {}
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        found: true, id: contact.id,
        firstname: props.firstname || "", lastname: props.lastname || "",
        email: props.email || "", phone: props.phone || props.mobilephone || "",
        lifecyclestage: props.lifecyclestage || "",
        notes_last_updated: props.notes_last_updated || "",
        ownerName, portalId: "147264621",
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
