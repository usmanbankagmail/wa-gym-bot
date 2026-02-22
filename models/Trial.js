import mongoose from "mongoose";

const TrialSchema = new mongoose.Schema(
  {
    waId: { type: String, required: true, index: true },
    phoneE164: { type: String, required: true },
    name: { type: String, required: true },

    day: { type: String, required: true }, // YYYY-MM-DD
    timeSlot: { type: String, required: true },

    status: {
      type: String,
      enum: ["booked", "attended", "no_show", "cancelled"],
      default: "booked"
    }
  },
  { timestamps: true }
);

export default mongoose.model("Trial", TrialSchema);