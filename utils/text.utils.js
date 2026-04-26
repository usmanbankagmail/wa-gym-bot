export function normalizeText(s = "") {
    return s.trim().toLowerCase();
}

export function isGreeting(text) {
    const t = normalizeText(text);
    return ["hi", "hello", "hey", "aoa", "assalam o alaikum", "menu"].includes(t);
}

export function isStop(text) {
    const t = normalizeText(text);
    return ["stop", "unsubscribe", "cancel"].includes(t);
}

export function isBot(text) {
    const t = normalizeText(text);
    return ["bot", "menu", "start"].includes(t);
}

export function isAgent(text) {
    const t = normalizeText(text);
    return ["agent", "human", "representative", "rep"].includes(t);
}
