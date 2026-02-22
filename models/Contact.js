import mongoose from "mongoose";

const ContactSchema = new mongoose.Schema(
  {
    waId: { type: String, required: true, unique: true, index: true }, // e.g. "92314..."
    phoneE164: { type: String, required: true }, // e.g. "+92314..."
    name: { type: String, default: "" },
    language: { type: String, enum: ["en", "ur", "mix"], default: "mix" },
    tags: { type: [String], default: [] },

    optIn: { type: Boolean, default: false },
    unsubscribed: { type: Boolean, default: false },

    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    lastThreadAt: { type: Date, default: null } // last inbound message time (for 24h window)
  },
  { timestamps: true }
);

export default mongoose.model("Contact", ContactSchema);