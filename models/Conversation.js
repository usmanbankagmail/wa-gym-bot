import mongoose from "mongoose";

const ConversationSchema = new mongoose.Schema(
  {
    waId: { type: String, required: true, unique: true, index: true },

    state: {
      type: String,
      enum: [
        "IDLE",
        "PRICING_GOAL",
        "TRIAL_NAME",
        "TRIAL_DAY",
        "TRIAL_TIME",
        "CONFIRM_TRIAL",
        "HUMAN"
      ],
      default: "IDLE"
    },

    context: {
      goal: { type: String, default: "" },
      trialName: { type: String, default: "" },
      trialDay: { type: String, default: "" }, // YYYY-MM-DD
      trialTimeSlot: { type: String, default: "" } // e.g. "Evening (4pm-11pm)"
    },

    // Human handoff
    handoffMode: { type: Boolean, default: false },

    // Multi-admin assignment (anti-collision)
    status: { type: String, enum: ["open", "assigned", "closed"], default: "open", index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser", default: null },
    assignedAt: { type: Date, default: null },

    // Fast inbox rendering
    lastMessageAt: { type: Date, default: null, index: true },
    lastMessagePreview: { type: String, default: "" }
  },
  { timestamps: true }
);

export default mongoose.model("Conversation", ConversationSchema);