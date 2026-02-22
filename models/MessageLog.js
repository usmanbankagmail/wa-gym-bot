import mongoose from "mongoose";

const MessageLogSchema = new mongoose.Schema(
  {
    waId: { type: String, required: true, index: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    type: { type: String, default: "text" },
    text: { type: String, default: "" },
    meta: { type: Object, default: {} }
  },
  { timestamps: true }
);

export default mongoose.model("MessageLog", MessageLogSchema);