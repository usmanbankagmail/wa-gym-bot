// index.mjs — WhatsApp Cloud API Gym Bot + Admin UI (single-file server)
// - Webhook verify + receive
// - Admin auth (JWT in httpOnly cookie)
// - Admin UI pages: /admin (login), /admin/app (dashboard)
// - Handoff mode tools + inbox + messages + send message

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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

dotenv.config();

const app = express();

// IMPORTANT for Railway/Reverse proxy so secure cookies & req.secure behave correctly
app.set("trust proxy", 1);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Admin auth env
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "dev_secret_change_me";
const ADMIN_SETUP_KEY = process.env.ADMIN_SETUP_KEY || "";

const isProd = process.env.NODE_ENV === "production";

// --- Mongo ---
let mongoConnectPromise = null;

async function ensureDbConnected() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not set");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (mongoConnectPromise) {
    return mongoConnectPromise;
  }

  mongoConnectPromise = mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000
  }).then((conn) => {
    console.log("✅ MongoDB connected");
    return conn;
  }).catch((err) => {
    console.error("❌ MongoDB connect error:", err.message);
    mongoConnectPromise = null;
    throw err;
  });

  return mongoConnectPromise;
}

// --- Helpers ---
function signAdminToken(admin) {
  return jwt.sign(
    { id: admin._id.toString(), role: admin.role, email: admin.email },
    ADMIN_JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// requireAdmin: verifies JWT cookie AND ensures DB is connected before every protected route
function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.admin_token;
    if (!token) return res.status(401).json({ ok: false, error: "Not logged in" });

    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    req.admin = payload;

    // Ensure DB is connected before the route handler runs
    ensureDbConnected()
      .then(() => next())
      .catch((err) => {
        console.error("DB connect failed in requireAdmin:", err.message);
        return res.status(500).json({ ok: false, error: "Database unavailable" });
      });

  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid session" });
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

// --- Health ---
app.get("/", (req, res) => res.send("OK"));

app.get("/test-db", async (req, res) => {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    res.send("DB CONNECTED");
  } catch (e) {
    res.send("DB ERROR: " + e.message);
  }
});

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
    .err{color:#b00020;margin-top:10px;white-space:pre-wrap}
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
  </div>

<script>
const msg = document.getElementById("msg");
function setMsg(text, cls){ msg.className = cls; msg.textContent = text; }

document.getElementById("f").addEventListener("submit", async function (e) {
  e.preventDefault();
  setMsg("", "");

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  const r = await fetch("/admin/auth/login", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ email: email, password: password })
  });

  const data = await r.json().catch(function(){ return {}; });

  if (!r.ok || !data.ok) {
    setMsg(data.error || ("Login failed (" + r.status + ")"), "err");
    return;
  }

  window.location.href = "/admin/app";
});
</script>
</body>
</html>`);
});

app.get("/admin/app", requireAdmin, (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Gym Admin</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;max-width:1100px;margin:36px auto;padding:0 16px;}
    .top{display:flex;justify-content:space-between;align-items:center;gap:10px}
    .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin-top:16px;background:#fff;}
    button{padding:10px 14px;border:0;border-radius:10px;cursor:pointer}
    pre{background:#f6f6f6;padding:12px;border-radius:12px;overflow:auto}
    a{color:#0b57d0;text-decoration:none}
    a:hover{text-decoration:underline}
    .links a{margin-right:14px}
    input, textarea, select{padding:10px;border:1px solid #ccc;border-radius:10px;width:100%;}
    textarea{min-height:80px;resize:vertical;}
    .small{color:#666;font-size:12px}
    .chatBtn{
      display:block;
      width:100%;
      text-align:left;
      white-space:normal;
      margin-top:8px;
      padding:12px;
      border:1px solid #ddd;
      border-radius:12px;
      background:#fff;
    }
    .chatBtn:hover{background:#f0f7ff;}
    .chatBtn.active{background:#d8ebff;border-color:#9cc7ff;}
    .msgRowIn{text-align:left;margin:10px 0;}
    .msgRowOut{text-align:right;margin:10px 0;}
    .msgBubble{
      display:inline-block;
      padding:10px;
      border-radius:10px;
      border:1px solid #ddd;
      max-width:80%;
      text-align:left;
      white-space:pre-wrap;
      word-break:break-word;
    }
    .msgIn{background:#ffffff;}
    .msgOut{background:#e9f3ff;}
    .statusBar{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
    .pill{
      display:inline-block;
      padding:4px 10px;
      border-radius:999px;
      font-size:12px;
      background:#f1f1f1;
      border:1px solid #ddd;
    }
    .actionRow{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
    .muted{color:#666;}
    .reportTableWrap{overflow:auto;}
    .reportTable{
      border-collapse:collapse;
      width:100%;
      font-size:13px;
      background:#fff;
    }
    .reportTable th,
    .reportTable td{
      border:1px solid #ccc;
      padding:8px;
      text-align:left;
      vertical-align:top;
      white-space:pre-wrap;
    }
    .reportTable th{
      background:#f0f0f0;
    }
  </style>
</head>
<body>

  <div class="top">
    <h2>Structure GYM - Admin Panel Page</h2>
    <button id="logout">Logout</button>
  </div>

  <div class="card">
    <div class="links">
      <a href="/admin/contacts" target="_blank">Contacts</a>
      <a href="/admin/inbox" target="_blank">Inbox</a>
      <a href="#reportsSection">Reports</a>
      <a href="/admin/me" target="_blank">Me</a>
    </div>
  </div>

  <div class="card" id="reportsSection">
    <h3>Reports</h3>
    <div class="small">Generate a future AI review of chats by contact number, date range, or scope.</div>

    <div style="margin-top:16px;display:flex;gap:12px;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;">
        <label class="small">Contact Number</label>
        <input id="reportContact" type="text" placeholder="e.g. 923001234567" />
      </div>
      <div style="flex:1;min-width:180px;">
        <label class="small">From Date</label>
        <input id="reportFromDate" type="date" />
      </div>
      <div style="flex:1;min-width:180px;">
        <label class="small">To Date</label>
        <input id="reportToDate" type="date" />
      </div>
      <div style="flex:1;min-width:180px;">
        <label class="small">Scope</label>
        <select id="reportScope">
          <option value="single">Single Contact</option>
          <option value="all">All Chats</option>
          <option value="date_range">Date Range</option>
        </select>
      </div>
      <div style="flex:1;min-width:180px;">
        <label class="small">Report Type</label>
        <select id="reportType">
          <option value="descriptive">Descriptive (Current)</option>
          <option value="table">Admin Performance Table</option>
        </select>
      </div>
    </div>

    <div class="actionRow" style="margin-top:16px;">
      <button id="generateReportBtn" type="button">Generate Report</button>
      <button id="analyzeReportBtn" type="button">Analyze with AI</button>
    </div>

    <div style="margin-top:16px;">
      <h4>Report Output</h4>
      <div id="reportOutput" style="background:#f6f6f6;padding:12px;border-radius:12px;overflow:auto;white-space:pre-wrap;min-height:40px;">No report generated yet.</div>
    </div>
  </div>

  <div class="card" style="padding:0;border:none;background:transparent;">
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">

      <div class="card" style="flex:1;min-width:300px;">
        <h3>Inbox</h3>
        <div style="margin-top:6px;">
          <label class="small">View:</label>
          <select id="scopeFilter">
            <option value="handoff">Handoff</option>
            <option value="all">All</option>
          </select>
        </div>
        <div id="inboxCount" class="small">Handoff chats: 0</div>
        <div class="actionRow">
          <button id="refreshInbox">Refresh Inbox</button>
        </div>
        <div id="inboxList" style="margin-top:12px"></div>
      </div>

      <div class="card" style="flex:2;min-width:380px;">
        <h3>Selected Chat</h3>
        <div id="selectedChatMeta" class="muted" style="margin-top:8px;">No chat selected</div>

        <h4 style="margin-top:16px">Messages</h4>
        <div id="msgsOut" style="background:#f6f6f6;padding:12px;border-radius:12px;min-height:320px;max-height:500px;overflow:auto"></div>

        <div style="margin-top:12px">
          <h4>Send message</h4>
          <textarea id="sendText" placeholder="Type message to send..."></textarea>
          <div class="actionRow">
            <button id="sendBtn">Send</button>
          </div>
          <pre id="sendResult"></pre>
        </div>
      </div>

    </div>
  </div>

<script>
let selectedWaId = null;
let selectedChatName = "";
let selectedChatAssigned = "";
let selectedChatStatus = "";
let currentReportTranscript = "";

let inboxTimer = null;
let chatTimer = null;

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderReportTable(columns, rows) {
  const container = document.getElementById("reportOutput");

  let html = '<div class="reportTableWrap">';
  html += '<table class="reportTable">';

  html += "<thead><tr>";
  columns.forEach(function(col) {
    html += "<th>" + escapeHtml(col) + "</th>";
  });
  html += "</tr></thead>";

  html += "<tbody>";
  rows.forEach(function(row) {
    html += "<tr>";

    columns.forEach(function(_, index) {
      const cell = Array.isArray(row) ? row[index] : "";
      html += "<td>" + escapeHtml(cell == null ? "" : String(cell)) + "</td>";
    });

    html += "</tr>";
  });
  html += "</tbody></table></div>";

  container.innerHTML = html;
}

async function loadInbox() {
  const scope = document.getElementById("scopeFilter").value;
  const r = await fetch("/admin/inbox/full?scope=" + scope);
  const data = await r.json().catch(function(){ return {}; });

  const list = document.getElementById("inboxList");
  const inboxCount = document.getElementById("inboxCount");
  list.innerHTML = "";

  if (!r.ok || !data.ok) {
    list.textContent = "Failed to load inbox";
    return;
  }

  if (!data.convos || data.convos.length === 0) {
    if (scope === "all") {
      inboxCount.textContent = "All chats: 0";
      list.textContent = "No conversations.";
    } else {
      inboxCount.textContent = "Handoff chats: 0";
      list.textContent = "No handoff conversations.";
    }
    return;
  }

  if (scope === "all") {
    inboxCount.textContent = "All chats: " + data.convos.length;
  } else {
    inboxCount.textContent = "Handoff chats: " + data.convos.length;
  }

  data.convos.sort(function(a, b) {
    const aWaiting = a.lastMessageFrom === "customer";
    const bWaiting = b.lastMessageFrom === "customer";
    if (aWaiting && !bWaiting) return -1;
    if (!aWaiting && bWaiting) return 1;
    return new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0);
  });

  data.convos.forEach(function(c) {
    const b = document.createElement("button");
    const name = (c.contact && c.contact.name) ? c.contact.name : "Unknown";
    const assigned = (c.assignedTo && c.assignedTo.name) ? c.assignedTo.name : "Unassigned";
    const preview = c.lastMessagePreview || "";
    const lastTime = c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : "No time";
    const status = c.status || "";
    const waiting = c.lastMessageFrom === "customer";

    if (selectedWaId === c.waId) {
      b.className = "chatBtn active";
    } else {
      b.className = "chatBtn";
    }

    b.innerHTML =
      '<div><strong>' + escapeHtml(name) + '</strong></div>' +
      '<div style="font-size:12px;color:#666;margin-top:4px;">' + escapeHtml(preview) + '</div>' +
      (waiting ? '<div style="color:#d93025;font-size:12px;margin-top:4px;">Customer waiting</div>' : '') +
      '<div style="font-size:12px;color:#999;margin-top:6px;">Last: ' + escapeHtml(lastTime) + '</div>' +
      '<div style="font-size:12px;color:#999;margin-top:6px;">Status: ' + escapeHtml(status) + ' | Assigned: ' + escapeHtml(assigned) + '</div>';

    b.addEventListener("click", function() {
      selectChat(c.waId, name, assigned, status, false);
    });

    list.appendChild(b);
  });
}

async function selectChat(waId, name, assigned, status, preserveScroll) {
  selectedWaId = waId;
  selectedChatName = name || "";
  selectedChatAssigned = assigned || "";
  selectedChatStatus = status || "";

  const meta = document.getElementById("selectedChatMeta");
  meta.innerHTML =
    '<div><strong>' + escapeHtml(name || "Customer") + '</strong> (' + escapeHtml(waId) + ')</div>' +
    '<div class="statusBar">' +
      '<span class="pill">Status: ' + escapeHtml(status || "") + '</span>' +
      '<span class="pill">Assigned: ' + escapeHtml(assigned || "Unassigned") + '</span>' +
    '</div>' +
    '<div class="actionRow">' +
      '<button type="button" id="assignBtn">Assign</button>' +
      '<button type="button" id="unassignBtn">Unassign</button>' +
      '<button type="button" id="closeBtn">Close</button>' +
    '</div>';

  document.getElementById("assignBtn").onclick = assignChat;
  document.getElementById("unassignBtn").onclick = unassignChat;
  document.getElementById("closeBtn").onclick = closeChat;

  const r = await fetch("/admin/conversations/" + encodeURIComponent(waId) + "/messages");
  const data = await r.json().catch(function(){ return {}; });

  const out = document.getElementById("msgsOut");
  const oldScrollTop = out.scrollTop;
  const oldScrollHeight = out.scrollHeight;

  if (!data.ok || !data.messages) {
    out.textContent = "No messages";
    return;
  }

  out.innerHTML = data.messages.map(function(m) {
    let who = "Bot";
    if (m.direction === "in") {
      who = "Customer";
    } else if (m.meta && m.meta.byAdminId) {
      who = "Admin";
    }

    const rowClass = m.direction === "in" ? "msgRowIn" : "msgRowOut";
    const bubbleClass = m.direction === "in" ? "msgBubble msgIn" : "msgBubble msgOut";
    const timeText = m.createdAt ? new Date(m.createdAt).toLocaleString() : "";

    return '' +
      '<div class="' + rowClass + '">' +
        '<div class="' + bubbleClass + '">' +
          '<div style="font-size:12px;color:#666;margin-bottom:4px;"><strong>' + escapeHtml(who) + '</strong></div>' +
          '<div>' + escapeHtml(m.text || "") + '</div>' +
          '<div style="font-size:11px;color:#999;margin-top:6px;">' + escapeHtml(timeText) + '</div>' +
        '</div>' +
      '</div>';
  }).join("");

  if (preserveScroll) {
    const newScrollHeight = out.scrollHeight;
    out.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
  } else {
    out.scrollTop = out.scrollHeight;
  }

  loadInbox();
}

async function assignChat() {
  if (!selectedWaId) return;

  const r = await fetch("/admin/conversations/" + encodeURIComponent(selectedWaId) + "/assign", {
    method: "POST"
  });
  const data = await r.json().catch(function(){ return {}; });

  if (!r.ok || !data.ok) {
    document.getElementById("sendResult").textContent = JSON.stringify(data, null, 2);
    return;
  }

  const assignedName =
    data.convo && data.convo.assignedTo && data.convo.assignedTo.name
      ? data.convo.assignedTo.name
      : "Unassigned";

  selectedChatAssigned = assignedName;
  selectedChatStatus = data.convo && data.convo.status ? data.convo.status : selectedChatStatus;

  await loadInbox();
  await selectChat(selectedWaId, selectedChatName, selectedChatAssigned, selectedChatStatus, true);
}

async function unassignChat() {
  if (!selectedWaId) return;

  const r = await fetch("/admin/conversations/" + encodeURIComponent(selectedWaId) + "/unassign", {
    method: "POST"
  });
  const data = await r.json().catch(function(){ return {}; });

  if (!r.ok || !data.ok) {
    document.getElementById("sendResult").textContent = JSON.stringify(data, null, 2);
    return;
  }

  selectedChatAssigned = "Unassigned";
  selectedChatStatus = "open";

  await loadInbox();
  await selectChat(selectedWaId, selectedChatName, selectedChatAssigned, selectedChatStatus, true);
}

async function closeChat() {
  if (!selectedWaId) return;

  const r = await fetch("/admin/conversations/" + encodeURIComponent(selectedWaId) + "/close", {
    method: "POST"
  });
  const data = await r.json().catch(function(){ return {}; });

  if (!r.ok || !data.ok) {
    document.getElementById("sendResult").textContent = JSON.stringify(data, null, 2);
    return;
  }

  selectedWaId = null;
  selectedChatName = "";
  selectedChatAssigned = "";
  selectedChatStatus = "";

  document.getElementById("selectedChatMeta").textContent = "No chat selected";
  document.getElementById("msgsOut").textContent = "";
  document.getElementById("sendResult").textContent = "";

  await loadInbox();
}

async function refreshSelectedChatSilently() {
  if (!selectedWaId) return;
  await selectChat(selectedWaId, selectedChatName, selectedChatAssigned, selectedChatStatus, true);
}

function startAutoRefresh() {
  if (inboxTimer) clearInterval(inboxTimer);
  inboxTimer = setInterval(function() {
    loadInbox();
  }, 5000);

  if (chatTimer) clearInterval(chatTimer);
  chatTimer = setInterval(function() {
    refreshSelectedChatSilently();
  }, 3000);
}

document.getElementById("refreshInbox").addEventListener("click", function() {
  loadInbox();
});

document.getElementById("scopeFilter").addEventListener("change", function() {
  loadInbox();
});

document.getElementById("generateReportBtn").addEventListener("click", async function() {
  const contact = document.getElementById("reportContact").value.trim();
  const fromDate = document.getElementById("reportFromDate").value;
  const toDate = document.getElementById("reportToDate").value;
  const scope = document.getElementById("reportScope").value;

  if (scope === "single" && !contact) {
    document.getElementById("reportOutput").textContent = "Please enter a contact number for Single Contact reports.";
    return;
  }

  const r = await fetch("/admin/reports/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contact: contact,
      fromDate: fromDate,
      toDate: toDate,
      scope: scope
    })
  });

  const data = await r.json().catch(function(){ return {}; });

  if (data.transcript) {
    currentReportTranscript = data.transcript;
    document.getElementById("reportOutput").textContent =
      "Total Messages: " + data.totalMessages + "\\n\\n" + data.transcript;
  } else {
    currentReportTranscript = "";
    document.getElementById("reportOutput").textContent = JSON.stringify(data, null, 2);
  }
});

document.getElementById("analyzeReportBtn").addEventListener("click", async function() {
  const contact = document.getElementById("reportContact").value.trim();
  const fromDate = document.getElementById("reportFromDate").value;
  const toDate = document.getElementById("reportToDate").value;
  const scope = document.getElementById("reportScope").value;
  const reportType = document.getElementById("reportType").value;

  const r = await fetch("/admin/reports/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contact: contact,
      fromDate: fromDate,
      toDate: toDate,
      scope: scope,
      reportType: reportType,
      transcript: currentReportTranscript
    })
  });

  const data = await r.json().catch(function(){ return {}; });

  if (!r.ok || !data.ok) {
    document.getElementById("reportOutput").textContent = JSON.stringify(data, null, 2);
    return;
  }

  if (data.reportType === "descriptive") {
    document.getElementById("reportOutput").textContent = data.aiText || "No descriptive report returned.";
    return;
  }

  if (data.reportType === "table") {
    if (Array.isArray(data.columns) && Array.isArray(data.rows)) {
      renderReportTable(data.columns, data.rows);
      return;
    }

    document.getElementById("reportOutput").textContent = "Table report returned invalid data.";
    return;
  }

  document.getElementById("reportOutput").textContent = JSON.stringify(data, null, 2);
});

document.getElementById("sendBtn").addEventListener("click", async function() {
  if (!selectedWaId) {
    document.getElementById("sendResult").textContent = "Select a chat first.";
    return;
  }

  const text = document.getElementById("sendText").value.trim();
  if (!text) {
    document.getElementById("sendResult").textContent = "Message text is required.";
    return;
  }

  const r = await fetch("/admin/conversations/" + encodeURIComponent(selectedWaId) + "/messages", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ text: text })
  });

  const data = await r.json().catch(function(){ return {}; });
  document.getElementById("sendResult").textContent = JSON.stringify(data, null, 2);

  if (r.ok && data.ok) {
    document.getElementById("sendText").value = "";
    await selectChat(selectedWaId, selectedChatName, selectedChatAssigned, selectedChatStatus, false);
    await loadInbox();
  }
});

document.getElementById("logout").addEventListener("click", async function() {
  await fetch("/admin/auth/logout", { method: "POST" });
  window.location.href = "/admin";
});

loadInbox();
startAutoRefresh();
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
  console.log("🔥 WEBHOOK HIT");
  console.log("BODY:", req.body);

  try {
    await ensureDbConnected();

    const body = req.body;
    if (body.object !== "whatsapp_business_account") return res.sendStatus(200);

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    console.log("VALUE:", JSON.stringify(value, null, 2));

    const messages = value?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];

    const waId = msg.from;
    const phoneE164 = waId.startsWith("+") ? waId : "+" + waId;
    const text = msg.text?.body || "";

    const interactive =
      msg.interactive?.type === "button_reply"
        ? { button_reply: msg.interactive.button_reply }
        : msg.interactive?.type === "list_reply"
        ? { list_reply: msg.interactive.list_reply }
        : null;

    const preview =
      text?.slice(0, 120) ||
      interactive?.button_reply?.title?.slice(0, 120) ||
      interactive?.list_reply?.title?.slice(0, 120) ||
      "[interactive]";

    await Conversation.updateOne(
      { waId: waId },
      {
        $setOnInsert: { waId: waId },
        $set: {
          lastMessageAt: new Date(),
          lastMessagePreview: preview,
          lastMessageFrom: "customer"
        }
      },
      { upsert: true }
    );

    await handleInbound({ waId, phoneE164, text, interactive });
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook error:", err?.response?.data || err.message || err);
    return res.sendStatus(200);
  }
});

// -------------------------
// Admin Auth + Setup
// -------------------------

app.post("/admin/setup", async (req, res) => {
  try {
    await ensureDbConnected();

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
      passwordHash: passwordHash,
      role: "manager",
      active: true
    });

    return res.json({
      ok: true,
      admin: { id: admin._id, email: admin.email, role: admin.role }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/admin/auth/login", async (req, res) => {
  try {
    await ensureDbConnected();

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
  res.clearCookie("admin_token", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd
  });
  res.json({ ok: true });
});

app.get("/admin/me", requireAdmin, async (req, res) => {
  const admin = await AdminUser.findById(req.admin.id).lean();
  if (!admin) return res.status(401).json({ ok: false, error: "Not found" });

  res.json({
    ok: true,
    admin: { id: admin._id, email: admin.email, role: admin.role, name: admin.name }
  });
});

// -------------------------
// Handoff Mode + Inbox APIs
// -------------------------

app.post("/admin/conversations/:waId/handoff/on", requireAdmin, async (req, res) => {
  try {
    const waId = (req.params.waId || "").trim();
    if (!waId) return res.status(400).json({ ok: false, error: "waId required" });

    const convo = await Conversation.findOneAndUpdate(
      { waId: waId },
      {
        $setOnInsert: { waId: waId },
        $set: {
          handoffMode: true,
          status: "open",
          assignedTo: null,
          assignedAt: null
        }
      },
      { upsert: true, new: true }
    ).lean();

    return res.json({ ok: true, convo: convo });
  } catch (e) {
    console.error("❌ handoff/on error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

app.get("/admin/inbox", requireAdmin, async (req, res) => {
  const status = req.query.status;
  const scope = req.query.scope || "handoff";

  const q = {};
  if (scope === "handoff") {
    q.handoffMode = true;
  }
  if (status) {
    q.status = status;
  }

  const convos = await Conversation.find(q)
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(300)
    .populate("assignedTo", "name email role")
    .lean();

  res.json({ ok: true, convos: convos });
});

app.get("/admin/inbox/full", requireAdmin, async (req, res) => {
  const status = req.query.status;
  const scope = req.query.scope || "handoff";

  const q = {};
  if (scope === "handoff") {
    q.handoffMode = true;
  }
  if (status) {
    q.status = status;
  }

  const convos = await Conversation.find(q)
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .limit(300)
    .populate("assignedTo", "name email role")
    .lean();

  const waIds = convos.map(function(c) { return c.waId; });
  const contacts = await Contact.find({ waId: { $in: waIds } }).lean();

  const contactMap = new Map(
    contacts.map(function(c) { return [c.waId, c]; })
  );

  const rows = convos.map(function(c) {
    return {
      ...c,
      contact: contactMap.get(c.waId) || null
    };
  });

  res.json({ ok: true, convos: rows });
});

app.post("/admin/conversations/:waId/assign", requireAdmin, async (req, res) => {
  const waId = req.params.waId;

  const updated = await Conversation.findOneAndUpdate(
    {
      waId: waId,
      handoffMode: true,
      $or: [
        { assignedTo: null },
        { assignedTo: new mongoose.Types.ObjectId(req.admin.id) }
      ]
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

  const convo = await Conversation.findOne({ waId: waId, handoffMode: true });
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

  const convo = await Conversation.findOne({ waId: waId });
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
  const logs = await MessageLog.find({ waId: waId }).sort({ createdAt: 1 }).limit(500).lean();
  res.json({ ok: true, messages: logs });
});

app.post("/admin/conversations/:waId/messages", requireAdmin, async (req, res) => {
  const waId = req.params.waId;
  const { text } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ ok: false, error: "text required" });
  }

  const convo = await Conversation.findOne({ waId: waId });
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
    waId: waId,
    direction: "out",
    type: "text",
    text: text.trim(),
    meta: { wa: waRes, byAdminId: req.admin.id }
  });

  convo.lastMessageAt = new Date();
  convo.lastMessagePreview = text.trim().slice(0, 120);
  convo.lastMessageFrom = "admin";
  await convo.save();

  res.json({ ok: true });
});

// -------------------------
// Gemini helpers
// -------------------------

async function callGeminiForReport(transcript) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const prompt = `
You are analyzing gym WhatsApp chats for the gym owner.

Read the transcript and return a short business analysis with these sections:
1. Potential customer or not
2. Lead temperature
3. Short summary
4. Admin mistakes
5. Missed sales opportunities
6. Suggested follow-up

Transcript:
${transcript}
  `.trim();

  const data = await callGeminiWithPrompt(prompt);

  return extractGeminiText(data);
}

async function callGeminiForTableReport(transcript) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const prompt = `
You are analyzing gym WhatsApp chats for the gym owner.

You must return ONLY valid JSON.
Do not wrap the JSON in markdown.
Do not add explanation text.
Do not add code fences.

Return exactly this structure:
{
  "columns": ["Column 1", "Column 2", "Column 3"],
  "rows": [
    ["value 1", "value 2", "value 3"]
  ]
}

Rules:
- "columns" must be an array of strings
- "rows" must be an array of arrays
- every row must have the same number of items as columns
- keep values short and business-relevant
- focus on admin performance, lead quality, missed opportunities, objections, follow-up quality, and sales signals
- if there is limited information, still return valid JSON with best-effort rows

Transcript:
${transcript}
  `.trim();

  const data = await callGeminiWithPrompt(prompt);
  const rawText = extractGeminiText(data);

  return parseGeminiTableJson(rawText);
}

async function callGeminiWithPrompt(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    }
  );

  const data = await response.json().catch(function () { return {}; });

  if (!response.ok) {
    throw new Error(data.error?.message || "Gemini request failed");
  }

  return data;
}

function extractGeminiText(data) {
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function parseGeminiTableJson(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Gemini returned empty table response");
  }

  let parsed = tryParseJson(rawText);

  if (!parsed) {
    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    parsed = tryParseJson(cleaned);
  }

  if (!parsed) {
    const firstBrace = rawText.indexOf("{");
    const lastBrace = rawText.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const sliced = rawText.slice(firstBrace, lastBrace + 1);
      parsed = tryParseJson(sliced);
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini did not return valid JSON object for table report");
  }

  const columns = Array.isArray(parsed.columns) ? parsed.columns : null;
  const rows = Array.isArray(parsed.rows) ? parsed.rows : null;

  if (!columns || !rows) {
    throw new Error("Table JSON must include columns and rows arrays");
  }

  const safeColumns = columns.map(function(col) {
    return String(col ?? "");
  });

  const expectedLength = safeColumns.length;

  if (expectedLength === 0) {
    throw new Error("Table report must include at least one column");
  }

  const safeRows = rows.map(function(row) {
    if (!Array.isArray(row)) {
      throw new Error("Each row must be an array");
    }

    const normalized = row.map(function(cell) {
      return String(cell ?? "");
    });

    if (normalized.length < expectedLength) {
      while (normalized.length < expectedLength) {
        normalized.push("");
      }
    }

    if (normalized.length > expectedLength) {
      return normalized.slice(0, expectedLength);
    }

    return normalized;
  });

  return {
    columns: safeColumns,
    rows: safeRows
  };
}

// -------------------------
// Reports
// -------------------------

app.post("/admin/reports/preview", requireAdmin, async (req, res) => {
  try {
    const { contact, fromDate, toDate, scope } = req.body || {};
    let query = {};

    if (scope === "single" && contact) {
      query.waId = contact;
    } else if (contact) {
      query.waId = contact;
    }

    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const messages = await MessageLog.find(query)
      .sort({ createdAt: 1 })
      .limit(10000)
      .lean();

    const transcript = messages.map(function(m) {
      let sender = "Bot";
      if (m.direction === "in") {
        sender = "Customer";
      } else if (m.meta && m.meta.byAdminId) {
        sender = "Admin";
      }
      return sender + ": " + (m.text || "");
    }).join("\n");

    return res.json({
      ok: true,
      totalMessages: messages.length,
      transcript: transcript
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/admin/reports/analyze", requireAdmin, async (req, res) => {
  try {
    const { transcript, reportType = "descriptive" } = req.body || {};

    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ ok: false, error: "Transcript is required" });
    }

    if (reportType === "descriptive") {
      const aiText = await callGeminiForReport(transcript);

      return res.json({
        ok: true,
        reportType: "descriptive",
        aiText: aiText || "No analysis returned."
      });
    }

    if (reportType === "table") {
      const tableResult = await callGeminiForTableReport(transcript);

      return res.json({
        ok: true,
        reportType: "table",
        columns: tableResult.columns,
        rows: tableResult.rows
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Invalid reportType. Allowed: descriptive, table"
    });
  } catch (err) {
    console.error("Report analysis error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to analyze report"
    });
  }
});

// -------------------------
// Simple admin endpoints
// -------------------------

app.get("/admin/trials", requireAdmin, async (req, res) => {
  const trials = await Trial.find({}).sort({ createdAt: -1 }).limit(200).lean();
  res.json(trials);
});

app.get("/admin/contacts", requireAdmin, async (req, res) => {
  const contacts = await Contact.find({}).sort({ updatedAt: -1 }).limit(200).lean();
  res.json(contacts);
});

app.post("/admin/trials/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ["booked", "attended", "no_show", "cancelled"];

  if (!allowed.includes(status)) {
    return res.status(400).json({ ok: false, error: "Invalid status" });
  }

  const trial = await Trial.findByIdAndUpdate(
    req.params.id,
    { $set: { status: status } },
    { new: true }
  );

  res.json({ ok: true, trial: trial });
});

app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));