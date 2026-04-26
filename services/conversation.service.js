import Conversation from "../models/Conversation.js";

export async function getOrCreateConversation(waId) {
  let convo = await Conversation.findOne({ waId });

  if (!convo) {
    convo = await Conversation.create({ waId });
  }

  return convo;
}