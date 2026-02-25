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

dotenv.config();

const app = express();

// IMPORTANT for Railway/Reverse proxy so secure cookies & req.secure behave correctly
app.set("trust proxy", 1);

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Admin auth env
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "dev_secret_change_me";
const ADMIN_SETUP_KEY = process.env.ADMIN_SETUP_KEY || ""; // set in Railway to enable /admin/setup

const isProd = process.env.NODE_ENV === "production";

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

function cookieOptions() {
  // In prod (Railway HTTPS) => secure cookie required.
  // In local dev (http://localhost) => secure must be false or cookie won't set.
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

// --- Health ---
app.get("/", (req, res) => res.send("OK"));

// -------------------------
// Admin UI (minimal, no build step)
// -------------------------

app.get("/admin", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Gym Admin Login</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;max-width:520px;margin:48px auto;padding:0 16px;}
    .card{border:1px solid #ddd;border-radius:12px;padding:18px;}
    label{display:block;margin:10px 0 6px;}
    input{width:100%;padding:10px;border:1px solid #ccc;border-radius:10px;}
    button{margin-top:14px;padding:10px 14px;border:0;border-radius:10px;cursor:pointer}
    .row{display:flex;gap:10px}
    .row > div{flex:1}
    .err{color:#b00020;margin-top:10px;white-space:pre-wrap}
    .ok{color:#0b6b0b;margin-top:10px;white-space:pre-wrap}
    code{background:#f6f6f6;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <h2>Admin Login</h2>
  <div class="card">
    <form id="f">
      <label>Email</label>
      <input id="email" type="email" autocomplete="username" required />
      <label>Password</label>
      <input id="password" type="password" autocomplete="current-password" required />
      <button type="submit">Login</button>
    </form>
    <div id="msg" class=""></div>
    <p style="margin-top:12px;color:#555">
      After login you should be redirected to <code>/admin/app</code>.
    </p>
  </div>

<script>
const msg = document.getElementById("msg");
function setMsg(text, cls){ msg.className = cls; msg.textContent = text; }

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg("", "");
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  const r = await fetch("/admin/auth/login", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({email, password})
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    setMsg(data.error || ("Login failed ("+r.status+")"), "err");
    return;
  }

  // Cookie is set by server. Now go to app.
  window.location.href = "/admin/app";
});
</script>
</body>
</html>`);
});

app.get("/admin/app", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Gym Admin</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;max-width:920px;margin:36px auto;padding:0 16px;}
    .top{display:flex;justify-content:space-between;align-items:center;gap:10px}
    .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin-top:16px;}
    button{padding:10px 14px;border:0;border-radius:10px;cursor:pointer}
    pre{background:#f6f6f6;padding:12px;border-radius:12px;overflow:auto}
    a{color:#0b57d0;text-decoration:none}
    a:hover{text-decoration:underline}
    .links a{margin-right:14px}
  </style>
</head>
<body>
  <div class="top">
    <h2>Admin Dashboard (MVP)</h2>
    <button id="logout">Logout</button>
  </div>

  <div class="card">
    <div class="links">
      <a href="/admin/trials" target="_blank">/admin/trials</a>
      <a href="/admin/contacts" target="_blank">/admin/contacts</a>
      <a href="/admin/inbox" target="_blank">/admin/inbox</a>
      <a href="/admin/me" target="_blank">/admin/me</a>
    </div>
  </div>

  <div class="card">
    <h3>Session check</h3>
    <div id="status">Loading...</div>
    <pre id="out"></pre>
  </div>

<script>
async function loadMe(){
  const r = await fetch("/admin/me");
  const data = await r.json().catch(()=>({}));
  document.getElementById("out").textContent = JSON.stringify(data, null, 2);
  document.getElementById("status").textContent =
    (r.ok && data.ok) ? ("Logged in as: " + data.admin.email + " (" + data.admin.role + ")")
                      : ("NOT logged in ("+r.status+"): " + (data.error || ""));
}

document.getElementById("logout").addEventListener("click", async ()=>{
  await fetch("/admin/auth/logout", { method:"POST" });
  window.location.href = "/admin";
});

loadMe();
</script>
</body>
</html>`);
});

// -------------------------
// Webhook Verify (GET)
// -------------------------
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

// -------------------------
// Webhook Receive (POST)
// -------------------------
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
      role: "manager",
      active: true
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
    res.cookie("admin_token", token, cookieOptions());

    return res.json({
      ok: true,
      admin: { id: admin._id, email: admin.email, role: admin.role, name: admin.name }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/admin/auth/logout", (req, res) => {
  // clear with same options footprint
  res.clearCookie("admin_token", { httpOnly: true, sameSite: "lax", secure: isProd });
  res.json({ ok: true });
});

app.get("/admin/me", requireAdmin, async (req, res) => {
  const admin = await AdminUser.findById(req.admin.id).lean();
  if (!admin) return res.status(401).json({ ok: false, error: "Not found" });
  res.json({ ok: true, admin: { id: admin._id, email: admin.email, role: admin.role, name: admin.name } });
});



// Enable handoff mode for a conversation
app.post("/admin/conversations/:waId/handoff/on", requireAdmin, async (req, res) => {
  const waId = req.params.waId;

  const convo = await Conversation.findOneAndUpdate(
    { waId },
    {
      $setOnInsert: { waId },
      $set: {
        handoffMode: true,
        status: "open",
        assignedTo: null,
        assignedAt: null
      }
    },
    { upsert: true, new: true }
  ).lean();

  res.json({ ok: true, convo });
});


// -------------------------
// Admin Inbox + Handoff APIs
// -------------------------

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

app.post("/admin/conversations/:waId/assign", requireAdmin, async (req, res) => {
  const waId = req.params.waId;

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

app.post("/admin/conversations/:waId/unassign", requireAdmin, async (req, res) => {
  const waId = req.params.waId;

  const convo = await Conversation.findOne({ waId, handoffMode: true });
  if (!convo) return res.status(404).json({ ok: false, error: "Not found" });

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

app.get("/admin/conversations/:waId/messages", requireAdmin, async (req, res) => {
  const waId = req.params.waId;
  const logs = await MessageLog.find({ waId }).sort({ createdAt: 1 }).limit(500).lean();
  res.json({ ok: true, logs });
});

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

  if (convo.assignedTo && !isAssignee && !isManager) {
    return res.status(409).json({ ok: false, error: "Chat assigned to another admin" });
  }

  if (!convo.assignedTo) {
    convo.assignedTo = new mongoose.Types.ObjectId(req.admin.id);
    convo.assignedAt = new Date();
    convo.status = "assigned";
  }

  const waRes = await sendText(waId, text.trim());

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

app.get("/admin/trials", requireAdmin, async (req, res) => {
  const trials = await Trial.find({}).sort({ createdAt: -1 }).limit(200).lean();
  res.json(trials);
});

app.get("/admin/contacts", requireAdmin, async (req, res) => {
  const contacts = await Contact.find({}).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(contacts);
});

app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));