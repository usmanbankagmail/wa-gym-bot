/**
 * index.js — WhatsApp Cloud API Gym Bot (MVP + Admin Page)
 * - Receives incoming messages via webhook
 * - Replies with interactive menu buttons
 * - Saves leads + trial bookings in MongoDB
 * - Admin page to view latest trial bookings (Basic Auth)
 *
 * Required .env:
 *   PORT=3000
 *   VERIFY_TOKEN=your_verify_token
 *   WHATSAPP_TOKEN=your_system_user_token
 *   PHONE_NUMBER_ID=your_phone_number_id
 *   MONGO_URI=mongodb://127.0.0.1:27017/gymbot   (or Atlas URI)
 *   ADMIN_USER=admin
 *   ADMIN_PASS=someStrongPassword
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // LOCAL DEV ONLY (remove in production)

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");

const app = express();
app.use(express.json());

const {
  PORT,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  MONGO_URI,
  ADMIN_USER,
  ADMIN_PASS,
} = process.env;

if (
  !PORT ||
  !VERIFY_TOKEN ||
  !WHATSAPP_TOKEN ||
  !PHONE_NUMBER_ID ||
  !MONGO_URI ||
  !ADMIN_USER ||
  !ADMIN_PASS
) {
  console.error(
    "Missing required env vars. Ensure PORT, VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, MONGO_URI, ADMIN_USER, ADMIN_PASS are set in .env / Railway Variables"
  );
  process.exit(1);
}

// -------------------- MongoDB --------------------
const leadSchema = new mongoose.Schema(
  {
    wa_id: { type: String, required: true, index: true },
    last_action: { type: String, default: "menu" }, // menu | pricing | location | trial_waiting_details
    last_message: { type: String, default: "" },
  },
  { timestamps: true }
);

const trialSchema = new mongoose.Schema(
  {
    wa_id: { type: String, required: true, index: true },
    details_text: { type: String, required: true }, // user provided "Name, Day, Time"
    status: { type: String, default: "new" }, // new | confirmed | cancelled
  },
  { timestamps: true }
);

const Lead = mongoose.model("Lead", leadSchema);
const TrialBooking = mongoose.model("TrialBooking", trialSchema);

async function connectMongo() {
  await mongoose.connect(MONGO_URI, { autoIndex: true });
  console.log("MongoDB connected");
}

// -------------------- WhatsApp send helpers --------------------
async function sendText(to, body) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

async function sendMenuButtons(to) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text:
            "Assalam-o-Alaikum! Welcome to *ABC Gym* 💪\n\n" +
            "Please choose an option:",
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: { id: "pricing", title: "Membership Pricing" },
            },
            {
              type: "reply",
              reply: { id: "trial", title: "Book Free Trial" },
            },
            {
              type: "reply",
              reply: { id: "location", title: "Location & Timings" },
            },
          ],
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

// -------------------- Bot content --------------------
function pricingText() {
  return (
    "*Membership Pricing*\n" +
    "- Monthly: PKR 6,000\n" +
    "- Quarterly: PKR 15,000\n" +
    "- Annual: PKR 50,000\n\n" +
    "Type *MENU* anytime to see options again."
  );
}

function locationText() {
  return (
    "*Location & Timings*\n" +
    "📍 Main Boulevard, Block X\n" +
    "🕒 Mon–Sat: 7am–11pm\n" +
    "🕒 Sun: 10am–8pm\n\n" +
    "Type *MENU* anytime to see options again."
  );
}

function trialPromptText() {
  return (
    "*Free Trial Booking*\n" +
    "Please reply with: Name, Day, Time\n" +
    "Example: Usman, Saturday, 7pm\n\n" +
    "Type *MENU* anytime to see options again."
  );
}

// -------------------- Admin (Basic Auth) --------------------
function requireBasicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Basic" || !token) {
    res.set("WWW-Authenticate", 'Basic realm="GymBot Admin"');
    return res.status(401).send("Auth required");
  }

  const decoded = Buffer.from(token, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  res.set("WWW-Authenticate", 'Basic realm="GymBot Admin"');
  return res.status(401).send("Invalid credentials");
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.send("OK - webhook server running"));

/** Admin page: latest trial bookings */
app.get("/admin/trials", requireBasicAuth, async (req, res) => {
  const trials = await TrialBooking.find().sort({ createdAt: -1 }).limit(100).lean();

  const rows =
    trials.length > 0
      ? trials
          .map(
            (t) => `
      <tr>
        <td>${t.createdAt ? new Date(t.createdAt).toISOString() : ""}</td>
        <td>${escapeHtml(t.wa_id || "")}</td>
        <td>${escapeHtml(t.details_text || "")}</td>
        <td>${escapeHtml(t.status || "")}</td>
      </tr>`
          )
          .join("")
      : `<tr><td colspan="4">No bookings yet</td></tr>`;

  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Trial Bookings</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 16px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
          th { background: #f4f4f4; text-align: left; }
          code { background:#f6f6f6; padding:2px 4px; border-radius:4px; }
        </style>
      </head>
      <body>
        <h2>Latest Trial Bookings (Top ${trials.length})</h2>
        <p>Endpoint: <code>/admin/trials</code></p>
        <table>
          <thead>
            <tr>
              <th>Created (UTC)</th>
              <th>wa_id</th>
              <th>Details</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
    </html>
  `);
});

/**
 * Webhook verification (Meta calls this during setup)
 * Callback URL: https://<public-domain>/webhook
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/** Incoming messages webhook */
app.post("/webhook", async (req, res) => {
  try {
    console.log("POST /webhook HIT");
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;

    // Ensure lead exists
    const lead = await Lead.findOneAndUpdate(
      { wa_id: from },
      { $setOnInsert: { wa_id: from } },
      { upsert: true, new: true }
    );

    // Handle interactive buttons
    if (message.type === "interactive" && message.interactive?.type === "button_reply") {
      const buttonId = message.interactive.button_reply.id;

      if (buttonId === "pricing") {
        await Lead.updateOne({ wa_id: from }, { $set: { last_action: "pricing" } });
        await sendText(from, pricingText());
        return res.sendStatus(200);
      }

      if (buttonId === "location") {
        await Lead.updateOne({ wa_id: from }, { $set: { last_action: "location" } });
        await sendText(from, locationText());
        return res.sendStatus(200);
      }

      if (buttonId === "trial") {
        await Lead.updateOne(
          { wa_id: from },
          { $set: { last_action: "trial_waiting_details" } }
        );
        await sendText(from, trialPromptText());
        return res.sendStatus(200);
      }

      await sendText(from, "Unknown option. Type *MENU* to see options again.");
      return res.sendStatus(200);
    }

    // Handle text
    const text = (message.text?.body || "").trim();
    const upper = text.toUpperCase();

    await Lead.updateOne({ wa_id: from }, { $set: { last_message: text } });

    // MENU keyword always shows menu
    if (!text || upper === "MENU" || upper === "HI" || upper === "HELLO" || upper === "AOA") {
      await Lead.updateOne({ wa_id: from }, { $set: { last_action: "menu" } });
      await sendMenuButtons(from);
      return res.sendStatus(200);
    }

    // If we are waiting for trial details, store booking
    if (lead.last_action === "trial_waiting_details") {
      await TrialBooking.create({ wa_id: from, details_text: text });
      await Lead.updateOne({ wa_id: from }, { $set: { last_action: "menu" } });

      await sendText(
        from,
        "✅ Thanks! Your trial request is received. Our team will confirm shortly.\n\nType *MENU* anytime."
      );
      return res.sendStatus(200);
    }

    // Default fallback: show menu
    await sendMenuButtons(from);
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// -------------------- Start --------------------
connectMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Listening on http://localhost:${PORT}`);
      console.log("Webhook endpoints:");
      console.log("  GET  /webhook   (verification)");
      console.log("  POST /webhook   (incoming messages)");
      console.log("Admin endpoint:");
      console.log("  GET  /admin/trials (Basic Auth)");
    });
  })
  .catch((e) => {
    console.error("Mongo connect failed:", e.message);
    process.exit(1);
  });