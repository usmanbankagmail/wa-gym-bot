import Contact from "../models/Contact.js";

export async function upsertInboundContact({ waId, phoneE164 }) {
  const contact = await Contact.findOneAndUpdate(
    { waId },
    {
      waId,
      phoneE164,
      lastInboundAt: new Date(),
      lastThreadAt: new Date()
    },
    { upsert: true, new:true }
  );

  return contact;
}