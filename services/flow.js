import Contact from "../models/Contact.js";
import Conversation from "../models/Conversation.js";
import Trial from "../models/Trial.js";
import MessageLog from "../models/MessageLog.js";
import { sendText, sendButtons } from "./whatsapp.js";

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeText(s = "") {
  return s.trim().toLowerCase();
}

function isGreeting(text) {
  const t = normalizeText(text);
  return ["hi", "hello", "hey", "aoa", "assalam o alaikum", "menu"].includes(t);
}

function isStop(text) {
  const t = normalizeText(text);
  return ["stop", "unsubscribe", "cancel"].includes(t);
}

function isBot(text) {
  const t = normalizeText(text);
  return ["bot", "menu", "start"].includes(t);
}

export async function handleInbound({ waId, phoneE164, text, interactive }) {
  // Log inbound
  await MessageLog.create({
    waId,
    direction: "in",
    type: interactive ? "interactive" : "text",
    text: text || "",
    meta: interactive || {}
  });

  // Upsert contact
  const contact = await Contact.findOneAndUpdate(
    { waId },
    {
      waId,
      phoneE164,
      lastInboundAt: new Date(),
      lastThreadAt: new Date()
    },
    { upsert: true, new: true }
  );

  // Upsert conversation
  let convo = await Conversation.findOne({ waId });
  if (!convo) convo = await Conversation.create({ waId });

  // Unsubscribe
  if (isStop(text || "")) {
    await Contact.updateOne({ waId }, { unsubscribed: true, optIn: false });
    await sendText(
      waId,
      "✅ You’re unsubscribed.\nAap ko ab messages nahi aayenge.\nType *START* to subscribe again."
    );
    await MessageLog.create({ waId, direction: "out", type: "text", text: "Unsubscribed confirm" });
    return;
  }

  // If in HUMAN mode, only allow BOT to return
  if (convo.handoffMode || convo.state === "HUMAN") {
    if (isBot(text || "")) {
      convo.handoffMode = false;
      convo.state = "IDLE";
      convo.context = {};
      await convo.save();

      await sendMainMenu(waId);
      return;
    }

    // Bot stays silent (human will reply from admin panel later)
    return;
  }

  // Determine user input (button vs text)
  const buttonId = interactive?.button_reply?.id || interactive?.list_reply?.id || null;
  const incomingText = text || "";

  // Global triggers
  if (isGreeting(incomingText) || buttonId === "MENU") {
    await sendMainMenu(waId);
    convo.state = "IDLE";
    convo.context = {};
    await convo.save();
    return;
  }

  if (buttonId === "HUMAN" || normalizeText(incomingText) === "agent" || normalizeText(incomingText) === "human") {
    convo.handoffMode = true;
    convo.state = "HUMAN";
    await convo.save();

    await sendText(
      waId,
      "✅ Team ko notify kar diya hai.\nRepresentative aap ko reply karega.\n\nType *BOT* to go back to menu."
    );
    await MessageLog.create({ waId, direction: "out", type: "text", text: "Handoff enabled" });
    return;
  }

  // Route by state
  switch (convo.state) {
    case "IDLE":
      return await handleIdle({ waId, convo, contact, buttonId, incomingText });

    case "PRICING_GOAL":
      return await handlePricingGoal({ waId, convo, buttonId, incomingText });

    case "TRIAL_NAME":
      return await handleTrialName({ waId, convo, contact, incomingText });

    case "TRIAL_DAY":
      return await handleTrialDay({ waId, convo, buttonId, incomingText });

    case "TRIAL_TIME":
      return await handleTrialTime({ waId, convo, buttonId, incomingText });

    case "CONFIRM_TRIAL":
      return await handleTrialConfirm({ waId, convo, contact, buttonId, incomingText });

    default:
      convo.state = "IDLE";
      convo.context = {};
      await convo.save();
      await sendMainMenu(waId);
      return;
  }
}

async function sendMainMenu(waId) {
  const body =
    "Assalam o Alaikum! 👋\nStructure Gym mein khush amdeed.\n\nHow can I help you?";

  await sendButtons(waId, body, [
    { id: "PRICING", title: "💰 Membership Pricing" },
    { id: "TRIAL", title: "🆓 Book Free Trial" },
    { id: "LOCATION", title: "📍 Location & Timings" }
  ]);

  // Add second row with human option as a follow-up text (buttons max 3)
  await sendText(waId, "Need help? Reply *AGENT* to talk to a representative.");
  await MessageLog.create({ waId, direction: "out", type: "interactive", text: "Main menu" });
}

async function handleIdle({ waId, convo, buttonId, incomingText }) {
  const t = normalizeText(incomingText);

  if (buttonId === "PRICING" || t.includes("pricing") || t.includes("price")) {
    convo.state = "PRICING_GOAL";
    convo.context = {};
    await convo.save();

    await sendButtons(waId, "Aap ka goal kya hai? (Choose one)", [
      { id: "GOAL_WEIGHT_LOSS", title: "Weight Loss" },
      { id: "GOAL_MUSCLE", title: "Muscle Gain" },
      { id: "GOAL_GENERAL", title: "General Fitness" }
    ]);
    await MessageLog.create({ waId, direction: "out", type: "interactive", text: "Ask goal" });
    return;
  }

  if (buttonId === "TRIAL" || t.includes("trial")) {
    convo.state = "TRIAL_NAME";
    convo.context = {};
    await convo.save();

    await sendText(waId, "Great! Free trial book karte hain ✅\nAap ka *name* kya hai?");
    await MessageLog.create({ waId, direction: "out", type: "text", text: "Ask name" });
    return;
  }

  if (buttonId === "LOCATION" || t.includes("location") || t.includes("timing")) {
    // Replace with your real info
    await sendText(
      waId,
      "📍 Location: (your address here)\n🕒 Timings:\nMorning: 6am–11am\nEvening: 4pm–11pm\n\nReply *TRIAL* to book a free trial."
    );
    await MessageLog.create({ waId, direction: "out", type: "text", text: "Location & timings" });
    return;
  }

  // Fallback
  await sendMainMenu(waId);
}

async function handlePricingGoal({ waId, convo, buttonId, incomingText }) {
  const goal =
    buttonId === "GOAL_WEIGHT_LOSS"
      ? "weight_loss"
      : buttonId === "GOAL_MUSCLE"
      ? "muscle_gain"
      : buttonId === "GOAL_GENERAL"
      ? "general"
      : "";

  if (!goal) {
    await sendText(waId, "Please button select karein (Weight Loss / Muscle Gain / General Fitness).");
    return;
  }

  convo.context.goal = goal;
  convo.state = "IDLE";
  await convo.save();

  // For now you only chose "Monthly" — we’ll expand plans later
  const msg =
    goal === "weight_loss"
      ? "✅ Weight loss ke liye best option: Monthly Membership.\n\nKya aap *free trial* book karna chahte hain?"
      : goal === "muscle_gain"
      ? "💪 Muscle gain ke liye: Monthly Membership (consistent training).\n\nFree trial book kar dein?"
      : "🏋️ General fitness ke liye: Monthly Membership.\n\nFree trial book kar dein?";

  await sendButtons(waId, msg, [
    { id: "TRIAL", title: "🆓 Book Free Trial" },
    { id: "MENU", title: "Menu" },
    { id: "HUMAN", title: "Talk to Rep" }
  ]);

  await MessageLog.create({ waId, direction: "out", type: "interactive", text: "Pricing result + upsell" });
}

async function handleTrialName({ waId, convo, contact, incomingText }) {
  const name = incomingText.trim();
  if (name.length < 2) {
    await sendText(waId, "Please apna name likhein (e.g., Ali).");
    return;
  }

  convo.context.trialName = name;
  convo.state = "TRIAL_DAY";
  await convo.save();

  // Save name to contact if empty
  if (!contact.name) {
    contact.name = name;
    await contact.save();
  }

  await sendButtons(waId, "Trial kis din chahiye?", [
    { id: "DAY_TODAY", title: "Today" },
    { id: "DAY_TOMORROW", title: "Tomorrow" },
    { id: "DAY_MANUAL", title: "Choose date" }
  ]);
  await MessageLog.create({ waId, direction: "out", type: "interactive", text: "Ask day" });
}

async function handleTrialDay({ waId, convo, buttonId, incomingText }) {
  if (buttonId === "DAY_TODAY") {
    convo.context.trialDay = todayISO();
  } else if (buttonId === "DAY_TOMORROW") {
    convo.context.trialDay = tomorrowISO();
  } else if (buttonId === "DAY_MANUAL") {
    await sendText(waId, "Date bhejein format mein: YYYY-MM-DD\nExample: 2026-02-28");
    return;
  } else {
    // manual date text
    const d = incomingText.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      await sendText(waId, "Invalid date. Please send: YYYY-MM-DD (Example: 2026-02-28)");
      return;
    }
    convo.context.trialDay = d;
  }

  convo.state = "TRIAL_TIME";
  await convo.save();

  await sendButtons(waId, "Time slot choose karein:", [
    { id: "TIME_MORNING", title: "Morning (6–11)" },
    { id: "TIME_EVENING", title: "Evening (4–11)" },
    { id: "TIME_MANUAL", title: "Specific time" }
  ]);
  await MessageLog.create({ waId, direction: "out", type: "interactive", text: "Ask time" });
}

async function handleTrialTime({ waId, convo, buttonId, incomingText }) {
  if (buttonId === "TIME_MORNING") {
    convo.context.trialTimeSlot = "Morning (6am-11am)";
  } else if (buttonId === "TIME_EVENING") {
    convo.context.trialTimeSlot = "Evening (4pm-11pm)";
  } else if (buttonId === "TIME_MANUAL") {
    await sendText(waId, "Time likhein (Example: 7:30pm).");
    return;
  } else {
    const t = incomingText.trim();
    if (t.length < 2) {
      await sendText(waId, "Please time likhein (Example: 7:30pm).");
      return;
    }
    convo.context.trialTimeSlot = `Specific: ${t}`;
  }

  convo.state = "CONFIRM_TRIAL";
  await convo.save();

  await sendButtons(
    waId,
    `Confirm karein ✅\n\nName: ${convo.context.trialName}\nDay: ${convo.context.trialDay}\nTime: ${convo.context.trialTimeSlot}`,
    [
      { id: "CONFIRM_YES", title: "Confirm" },
      { id: "CONFIRM_NO", title: "Change" },
      { id: "MENU", title: "Menu" }
    ]
  );
  await MessageLog.create({ waId, direction: "out", type: "interactive", text: "Confirm trial" });
}

async function handleTrialConfirm({ waId, convo, contact, buttonId, incomingText }) {
  if (buttonId === "CONFIRM_NO" || normalizeText(incomingText) === "change") {
    convo.state = "TRIAL_DAY";
    await convo.save();
    await sendText(waId, "No problem. Trial kis din chahiye? (Today/Tomorrow/Choose)");
    return;
  }

  if (buttonId !== "CONFIRM_YES") {
    await sendText(waId, "Please *Confirm* button press karein.");
    return;
  }

  const name = convo.context.trialName || contact.name || "Member";
  const day = convo.context.trialDay;
  const timeSlot = convo.context.trialTimeSlot;

  await Trial.create({
    waId,
    phoneE164: contact.phoneE164,
    name,
    day,
    timeSlot,
    status: "booked"
  });

  // Tag lead
  await Contact.updateOne({ waId }, { $addToSet: { tags: "trial_booked" }, optIn: true });

  convo.state = "IDLE";
  convo.context = {};
  await convo.save();

  await sendText(
    waId,
    `✅ Trial booked!\n\nName: ${name}\nDay: ${day}\nTime: ${timeSlot}\n\nPlease 10 min pehle aa jayein. Reply *MENU* for options.`
  );
  await MessageLog.create({ waId, direction: "out", type: "text", text: "Trial booked confirmation" });
}