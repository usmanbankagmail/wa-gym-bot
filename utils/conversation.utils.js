export function resetContext(convo) {
    convo.context = {
        goal: "",
        trialName: "",
        trialDay: "",
        trialTimeSlot: ""
    };
}

export function enableHandoff(convo) {
    convo.handoffMode = true;
    convo.state = "HUMAN";
    convo.status = "open";
    convo.assignedTo = null;
    convo.assignedAt = null;
}

export function disableHandoff(convo) {
    convo.handoffMode = false;
    convo.state = "IDLE";
    convo.status = "closed";
    convo.assignedTo = null;
    convo.assignedAt = null;
    resetContext(convo);
}