import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import Trial from "./models/Trial.js";
import Conversation from "./models/Conversation.js";
import Contact from "./models/Contact.js";
import MessageLog from "./models/MessageLog.js";
import AdminUser from "./models/AdminUser.js";

import { handleInbound } from "./services/flows.js";
import { sendText } from "./services/whatsapp.js";

import AdminUser from "./models/AdminUser.js";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Admin auth env
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "dev_secret_change_me";
const ADMIN_SETUP_KEY = process.env.ADMIN_SETUP_KEY || ""; // set in Railway to enable /admin/setup

// --- Mongo ---
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

// --- Helpers ---
function signAdminToken(admin) {
  return jwt.sign(
    { id: admin._id.toString(), role: admin.role, email: admin.email },
    ADMIN_JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.admin_token;
    if (!token) return res.status(401).json({ ok: false, error: "Not logged in" });

    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    req.admin = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid session" });
  }
}

// --- Health ---
app.get("/", (req, res) => res.send("OK"));

// --- Webhook Verify (GET) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Webhook Receive (POST) ---
app.post("/webhook", async (req, res) => {
  // Ack fast
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const waId = msg.from; // digits
    const phoneE164 = waId.startsWith("+") ? waId : `+${waId}`;

    const text = msg.text?.body || "";
    const interactive =
      msg.interactive?.type === "button_reply"
        ? { button_reply: msg.interactive.button_reply }
        : msg.interactive?.type === "list_reply"
        ? { list_reply: msg.interactive.list_reply }
        : null;

    // Update conversation "inbox" metadata early (even if flows changes)
    const preview =
      text?.slice(0, 120) ||
      (interactive?.button_reply?.title?.slice(0, 120)) ||
      (interactive?.list_reply?.title?.slice(0, 120)) ||
      "[interactive]";

    await Conversation.updateOne(
      { waId },
      {
        $setOnInsert: { waId },
        $set: { lastMessageAt: new Date(), lastMessagePreview: preview }
      },
      { upsert: true }
    );

    await handleInbound({ waId, phoneE164, text, interactive });
  } catch (err) {
    console.error("❌ webhook error:", err?.response?.data || err.message);
  }
});

// -------------------------
// Admin Auth + Setup
// -------------------------

// One-time setup to create FIRST admin (recommended)
app.post("/admin/setup", async (req, res) => {
  try {
    if (!ADMIN_SETUP_KEY) {
      return res.status(403).json({ ok: false, error: "ADMIN_SETUP_KEY not set" });
    }
    const key = req.headers["x-setup-key"];
    if (key !== ADMIN_SETUP_KEY) {
      return res.status(403).json({ ok: false, error: "Bad setup key" });
    }

    const count = await AdminUser.countDocuments({});
    if (count > 0) {
      return res.status(400).json({ ok: false, error: "Admin already exists" });
    }

    const { name, email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email + password required" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await AdminUser.create({
      name: name || "Admin",
      email: email.toLowerCase(),
      passwordHash,
      role: "manager"
    });

    return res.json({ ok: true, admin: { id: admin._id, email: admin.email, role: admin.role } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/admin/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email + password required" });
    }

    const admin = await AdminUser.findOne({ email: email.toLowerCase(), active: true });
    if (!admin) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const token = signAdminToken(admin);
    res.cookie("admin_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: true, // Railway is HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.json({ ok: true, admin: { id: admin._id, email: admin.email, role: admin.role, name: admin.name } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/admin/auth/logout", (req, res) => {
  res.clearCookie("admin_token");
  res.json({ ok: true });
});

app.get("/admin/me", requireAdmin, async (req, res) => {
  const admin = await AdminUser.findById(req.admin.id).lean();
  if (!admin) return res.status(401).json({ ok: false, error: "Not found" });
  res.json({ ok: true, admin: { id: admin._id, email: admin.email, role: admin.role, name: admin.name } });
});

// -------------------------
// Admin Inbox + Handoff APIs
// -------------------------

// List handoff conversations
app.get("/admin/inbox", requireAdmin, async (req, res) => {
  const status = req.query.status; // open|assigned|closed
  const q = { handoffMode: true };
  if (status) q.status = status;

  const convos = await Conversation.find(q)
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(300)
    .populate("assignedTo", "name email role")
    .lean();

  res.json({ ok: true, convos });
});

// Take/assign a chat (anti-collision)
app.post("/admin/conversations/:waId/assign", requireAdmin, async (req, res) => {
  const waId = req.params.waId;

  // Only assign if unassigned OR already assigned to me
  const updated = await Conversation.findOneAndUpdate(
    {
      waId,
      handoffMode: true,
      $or: [{ assignedTo: null }, { assignedTo: new mongoose.Types.ObjectId(req.admin.id) }]
    },
    {
      $set: {
        status: "assigned",
        assignedTo: new mongoose.Types.ObjectId(req.admin.id),
        assignedAt: new Date()
      }
    },
    { new: true }
  ).populate("assignedTo", "name email role");

  if (!updated) {
    return res.status(409).json({ ok: false, error: "Already assigned to another admin" });
  }

  res.json({ ok: true, convo: updated });
});

// Release a chat
app.post("/admin/conversations/:waId/unassign", requireAdmin, async (req, res) => {
  const waId = req.params.waId;

  const convo = await Conversation.findOne({ waId, handoffMode: true });
  if (!convo) return res.status(404).json({ ok: false, error: "Not found" });

  // Only assignee or manager can unassign
  const isAssignee = convo.assignedTo?.toString() === req.admin.id;
  const isManager = req.admin.role === "manager";
  if (!isAssignee && !isManager) {
    return res.status(403).json({ ok: false, error: "Not allowed" });
  }

  convo.assignedTo = null;
  convo.assignedAt = null;
  convo.status = "open";
  await convo.save();

  res.json({ ok: true });
});

// Close chat (end handoff)
app.post("/admin/conversations/:waId/close", requireAdmin, async (req, res) => {
  const waId = req.params.waId;

  const convo = await Conversation.findOne({ waId });
  if (!convo) return res.status(404).json({ ok: false, error: "Not found" });

  const isAssignee = convo.assignedTo?.toString() === req.admin.id;
  const isManager = req.admin.role === "manager";
  if (!isAssignee && !isManager) {
    return res.status(403).json({ ok: false, error: "Not allowed" });
  }

  convo.handoffMode = false;
  convo.status = "closed";
  convo.assignedTo = null;
  convo.assignedAt = null;
  convo.state = "IDLE";
  await convo.save();

  res.json({ ok: true });
});

// Get messages
app.get("/admin/conversations/:waId/messages", requireAdmin, async (req, res) => {
  const waId = req.params.waId;
  const logs = await MessageLog.find({ waId }).sort({ createdAt: 1 }).limit(500).lean();
  res.json({ ok: true, logs });
});

// Send message as admin (WhatsApp + DB)
app.post("/admin/conversations/:waId/messages", requireAdmin, async (req, res) => {
  const waId = req.params.waId;
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ ok: false, error: "text required" });
  }

  const convo = await Conversation.findOne({ waId });
  if (!convo) return res.status(404).json({ ok: false, error: "Conversation not found" });

  if (!convo.handoffMode) {
    return res.status(400).json({ ok: false, error: "Not in handoff mode" });
  }

  const isAssignee = convo.assignedTo?.toString() === req.admin.id;
  const isManager = req.admin.role === "manager";

  // If assigned to someone else, block typing (anti-collision)
  if (convo.assignedTo && !isAssignee && !isManager) {
    return res.status(409).json({ ok: false, error: "Chat assigned to another admin" });
  }

  // If unassigned, auto-assign to sender
  if (!convo.assignedTo) {
    convo.assignedTo = new mongoose.Types.ObjectId(req.admin.id);
    convo.assignedAt = new Date();
    convo.status = "assigned";
  }

  // Send WhatsApp
  const waRes = await sendText(waId, text.trim());

  // Save message log
  await MessageLog.create({
    waId,
    direction: "out",
    type: "text",
    text: text.trim(),
    meta: { wa: waRes, byAdminId: req.admin.id }
  });

  convo.lastMessageAt = new Date();
  convo.lastMessagePreview = text.trim().slice(0, 120);
  await convo.save();

  res.json({ ok: true });
});

// -------------------------
// Existing simple admin endpoints (keep)
/// -------------------------

app.get("/admin/trials", requireAdmin, async (req, res) => {
  const trials = await Trial.find({}).sort({ createdAt: -1 }).limit(200).lean();
  res.json(trials);
});

app.get("/admin/contacts", requireAdmin, async (req, res) => {
  const contacts = await Contact.find({}).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(contacts);
});


function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

app.post("/admin/setup", async (req, res) => {
  try {
    const ADMIN_SETUP_KEY = process.env.ADMIN_SETUP_KEY;

    if (!ADMIN_SETUP_KEY) {
      return res.status(500).json({ error: "Missing ADMIN_SETUP_KEY env on server" });
    }

    const headerKey = req.headers["x-setup-key"];
    if (!headerKey || headerKey !== ADMIN_SETUP_KEY) {
      return res.status(401).json({ error: "Invalid setup key" });
    }

    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Required: name, email, password" });
    }

    const existing = await AdminUser.findOne({}).lean();
    if (existing) {
      return res.status(409).json({ error: "Admin already initialized" });
    }

    const user = await AdminUser.create({
      name,
      email: email.toLowerCase().trim(),
      passwordHash: hashPassword(password),
      role: "admin",
      active: true
    });

    return res.status(201).json({
      ok: true,
      adminId: user._id,
      email: user.email,
      role: user.role
    });
  } catch (err) {
    console.error("❌ /admin/setup error:", err?.message || err);
    return res.status(500).json({ error: "Server error" });
  }
});



app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));