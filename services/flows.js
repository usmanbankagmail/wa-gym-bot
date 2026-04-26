import Contact from "../models/Contact.js";
import Conversation from "../models/Conversation.js";
import Trial from "../models/Trial.js";
import MessageLog from "../models/MessageLog.js";
import { sendText, sendButtons } from "./whatsapp.js";
import { normalizeText, isGreeting, isStop, isBot, isAgent } from "../utils/text.utils.js";
import { todayISO, tomorrowISO } from "../utils/date.utils.js";


function resetContext(convo) {
  convo.context = {
    goal: "",
    trialName: "",
    trialDay: "",
    trialTimeSlot: ""
  };
}

async function enableHandoff(convo) {
  convo.handoffMode = true;
  convo.state = "HUMAN";
  convo.status = "open";
  convo.assignedTo = null;
  convo.assignedAt = null;
}

async function disableHandoff(convo) {
  convo.handoffMode = false;
  convo.state = "IDLE";
  convo.status = "closed";
  convo.assignedTo = null;
  convo.assignedAt = null;
  resetContext(convo);
}

export async function handleInbound({ waId, phoneE164, text, interactive }) {
  const inboundText =
    text ||
    interactive?.button_reply?.title ||
    interactive?.list_reply?.title ||
    "";

  await MessageLog.create({
    waId,
    direction: "in",
    type: interactive ? "interactive" : "text",
    text: inboundText,
    meta: interactive || {}
  });

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

  let convo = await Conversation.findOne({ waId });
  if (!convo) convo = await Conversation.create({ waId });

  if (isStop(text || "")) {
    await Contact.updateOne({ waId }, { unsubscribed: true, optIn: false });

    const unsubscribeMsg =
      "✅ You’re unsubscribed.\nAap ko ab messages nahi aayenge.\nType *START* to subscribe again.";

    await sendText(waId, unsubscribeMsg);

    await MessageLog.create({
      waId,
      direction: "out",
      type: "text",
      text: unsubscribeMsg
    });
    return;
  }

  if (convo.handoffMode || convo.state === "HUMAN") {
    if (isBot(text || "")) {
      await disableHandoff(convo);
      await convo.save();
      await sendMainMenu(waId);
      return;
    }

    return;
  }

  const buttonId = interactive?.button_reply?.id || interactive?.list_reply?.id || null;
  const incomingText = text || "";

  if (isGreeting(incomingText) || buttonId === "MENU") {
    await sendMainMenu(waId);
    convo.state = "IDLE";
    resetContext(convo);
    await convo.save();
    return;
  }

  if (buttonId === "HUMAN" || isAgent(incomingText)) {
    await enableHandoff(convo);
    await convo.save();

    const handoffMsg =
      "✅ Team ko notify kar diya hai.\nRepresentative aap ko reply karega.\n\nType *BOT* to go back to menu.";

    await sendText(waId, handoffMsg);

    await MessageLog.create({
      waId,
      direction: "out",
      type: "text",
      text: handoffMsg
    });
    return;
  }

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
      resetContext(convo);
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

  const helpText = "Need help? Reply *AGENT* to talk to a representative.";
  await sendText(waId, helpText);

  await MessageLog.create({
    waId,
    direction: "out",
    type: "interactive",
    text: body + "\n\n" + helpText,
    meta: {
      buttons: [
        "💰 Membership Pricing",
        "🆓 Book Free Trial",
        "📍 Location & Timings"
      ]
    }
  });
}

async function handleIdle({ waId, convo, buttonId, incomingText }) {
  const t = normalizeText(incomingText);

  if (buttonId === "PRICING" || t.includes("pricing") || t.includes("price")) {
    convo.state = "PRICING_GOAL";
    resetContext(convo);
    await convo.save();

    const goalText = "Aap ka goal kya hai? (Choose one)";

    await sendButtons(waId, goalText, [
      { id: "GOAL_WEIGHT_LOSS", title: "Weight Loss" },
      { id: "GOAL_MUSCLE", title: "Muscle Gain" },
      { id: "GOAL_GENERAL", title: "General Fitness" }
    ]);

    await MessageLog.create({
      waId,
      direction: "out",
      type: "interactive",
      text: goalText,
      meta: {
        buttons: [
          "Weight Loss",
          "Muscle Gain",
          "General Fitness"
        ]
      }
    });
    return;
  }

  if (buttonId === "TRIAL" || t.includes("trial")) {
    convo.state = "TRIAL_NAME";
    resetContext(convo);
    await convo.save();

    const askNameText = "Great! Free trial book karte hain ✅\nAap ka *name* kya hai?";
    await sendText(waId, askNameText);

    await MessageLog.create({
      waId,
      direction: "out",
      type: "text",
      text: askNameText
    });
    return;
  }

  if (buttonId === "LOCATION" || t.includes("location") || t.includes("timing")) {
    const locationText =
      "📍 Location: (your address here)\n🕒 Timings:\nMorning: 6am–11am\nEvening: 4pm–11pm\n\nReply *TRIAL* to book a free trial.";

    await sendText(waId, locationText);

    await MessageLog.create({
      waId,
      direction: "out",
      type: "text",
      text: locationText
    });
    return;
  }

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

  await MessageLog.create({
    waId,
    direction: "out",
    type: "interactive",
    text: msg,
    meta: {
      buttons: [
        "🆓 Book Free Trial",
        "Menu",
        "Talk to Rep"
      ]
    }
  });
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

  if (!contact.name) {
    contact.name = name;
    await contact.save();
  }

  const askDayText = "Trial kis din chahiye?";

  await sendButtons(waId, askDayText, [
    { id: "DAY_TODAY", title: "Today" },
    { id: "DAY_TOMORROW", title: "Tomorrow" },
    { id: "DAY_MANUAL", title: "Choose date" }
  ]);

  await MessageLog.create({
    waId,
    direction: "out",
    type: "interactive",
    text: askDayText,
    meta: {
      buttons: [
        "Today",
        "Tomorrow",
        "Choose date"
      ]
    }
  });
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
    const d = incomingText.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      await sendText(waId, "Invalid date. Please send: YYYY-MM-DD (Example: 2026-02-28)");
      return;
    }
    convo.context.trialDay = d;
  }

  convo.state = "TRIAL_TIME";
  await convo.save();

  const askTimeSlotText = "Time slot choose karein:";

  await sendButtons(waId, askTimeSlotText, [
    { id: "TIME_MORNING", title: "Morning (6–11)" },
    { id: "TIME_EVENING", title: "Evening (4–11)" },
    { id: "TIME_MANUAL", title: "Specific time" }
  ]);

  await MessageLog.create({
    waId,
    direction: "out",
    type: "interactive",
    text: askTimeSlotText,
    meta: {
      buttons: [
        "Morning (6–11)",
        "Evening (4–11)",
        "Specific time"
      ]
    }
  });
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

  const confirmText =
    `Confirm karein ✅\n\nName: ${convo.context.trialName}\nDay: ${convo.context.trialDay}\nTime: ${convo.context.trialTimeSlot}`;

  await sendButtons(waId, confirmText, [
    { id: "CONFIRM_YES", title: "Confirm" },
    { id: "CONFIRM_NO", title: "Change" },
    { id: "MENU", title: "Menu" }
  ]);

  await MessageLog.create({
    waId,
    direction: "out",
    type: "interactive",
    text: confirmText,
    meta: {
      buttons: [
        "Confirm",
        "Change",
        "Menu"
      ]
    }
  });
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

  await Contact.updateOne(
    { waId },
    { $addToSet: { tags: "trial_booked" }, optIn: true }
  );

  convo.state = "IDLE";
  resetContext(convo);
  await convo.save();

  const bookedText =
    `✅ Trial booked!\n\nName: ${name}\nDay: ${day}\nTime: ${timeSlot}\n\nPlease 10 min pehle aa jayein. Reply *MENU* for options.`;

  await sendText(waId, bookedText);

  await MessageLog.create({
    waId,
    direction: "out",
    type: "text",
    text: bookedText
  });
}