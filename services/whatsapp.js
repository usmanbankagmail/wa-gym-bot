import axios from "axios";

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v19.0";

function getWhatsAppConfig() {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const token = process.env.WA_TOKEN;

  if (!phoneNumberId) {
    throw new Error("Missing env WA_PHONE_NUMBER_ID");
  }

  if (!token) {
    throw new Error("Missing env WA_TOKEN");
  }

  return { phoneNumberId, token };
}

export async function sendText(toWaId, text) {
  const { phoneNumberId, token } = getWhatsAppConfig();

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "text",
    text: { body: text }
  };

  const res = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return res.data;
}

export async function sendButtons(toWaId, bodyText, buttons) {
  const { phoneNumberId, token } = getWhatsAppConfig();

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

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
    headers: { Authorization: `Bearer ${token}` }
  });

  return res.data;
}