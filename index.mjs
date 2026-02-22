import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";

import Trial from "./models/Trial.js";
import Conversation from "./models/Conversation.js";
import Contact from "./models/Contact.js";
import MessageLog from "./models/MessageLog.js";
import { handleInbound } from "./services/flows.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// --- Mongo ---
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

// --- Health ---
app.get("/", (req, res) => res.send("OK"));

// --- Webhook Verify (GET) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Webhook Receive (POST) ---
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }

    // Acknowledge immediately
    res.sendStatus(200);

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const waId = msg.from; // wa_id (digits)
    const phoneE164 = waId.startsWith("+" ) ? waId : `+${waId}`;

    const text = msg.text?.body || "";
    const interactive =
      msg.interactive?.type === "button_reply"
        ? { button_reply: msg.interactive.button_reply }
        : msg.interactive?.type === "list_reply"
        ? { list_reply: msg.interactive.list_reply }
        : null;

    await handleInbound({ waId, phoneE164, text, interactive });
  } catch (err) {
    console.error("❌ webhook error:", err?.response?.data || err.message);
  }
});

// --- Simple Admin: Trials ---
app.get("/admin/trials", async (req, res) => {
  const trials = await Trial.find({}).sort({ createdAt: -1 }).limit(200).lean();
  res.json(trials);
});

// --- Simple Admin: Conversations needing human ---
app.get("/admin/handoff", async (req, res) => {
  const convos = await Conversation.find({ handoffMode: true }).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(convos);
});

// --- Simple Admin: Contacts ---
app.get("/admin/contacts", async (req, res) => {
  const contacts = await Contact.find({}).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(contacts);
});

// --- Simple Admin: Message logs for a user ---
app.get("/admin/messages/:waId", async (req, res) => {
  const waId = req.params.waId;
  const logs = await MessageLog.find({ waId }).sort({ createdAt: -1 }).limit(200).lean();
  res.json(logs.reverse());
});

app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));