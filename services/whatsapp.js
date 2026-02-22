import axios from "axios";

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v19.0";
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID; // 1063799373474115
const TOKEN = process.env.WA_TOKEN; // System User access token (EAAG...)

if (!PHONE_NUMBER_ID) console.warn("Missing env WA_PHONE_NUMBER_ID");
if (!TOKEN) console.warn("Missing env WA_TOKEN");

export async function sendText(toWaId, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "text",
    text: { body: text }
  };

  const res = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });

  return res.data;
}

export async function sendButtons(toWaId, bodyText, buttons) {
  // buttons: [{ id:"PRICING", title:"Membership Pricing" }, ...]
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title }
        }))
      }
    }
  };

  const res = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });

  return res.data;
}