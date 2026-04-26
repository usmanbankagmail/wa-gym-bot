import MessageLog from "../models/MessageLog.js";

export async function logInboudMessage({ waId, text, interactive }) {
    const inboundText =
    text ||
    interactive?.button_reply?.title ||
    interactive?.list_reply?.title ||
    "";

  await MessageLog.create({
    waId,
    direction: "in",
    type: interactive ? "interactive" : "text",
    text: inboundText,
    meta: interactive || {}
  });

  return inboundText;
}