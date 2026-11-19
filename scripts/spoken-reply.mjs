export const immediateReplyInstructions = [
  "Answer the latest user request in the user's language in one or two short spoken sentences. Use plain text without Markdown.",
  "Give the useful answer you can provide in this call. Do not end with only an acknowledgement or a promise to check later.",
  "For integration questions, distinguish general support from the current connection status. If you cannot verify the status or perform the action here, say so and give a concrete check the user can do.",
].join(" ");

export const toolFreeSpokenReplyInstructions = [
  immediateReplyInstructions,
  "This Huddle can only converse. It has no tools, cannot inspect live external services or change settings, and cannot send a follow-up after this reply.",
  "Do not ask the user to wait, imply work is running, or suggest switching models will grant access.",
].join(" ");

// Only replace a standalone promise. Leave answers with substantive text intact.
const koreanStatusOnly = /^(?:(?:네|예|좋아요|알겠습니다|알겠어요)[\s,.!]+)*(?:잠시만(?:\s+기다려\s*주세요)?|(?:제가\s+)?(?:한\s*번\s+)?(?:알아|확인해\s*|살펴)\s*(?:볼게요|보겠습니다|보고\s*알려\s*드릴게요)|(?:확인|조사)\s*(?:할게요|하겠습니다|하고\s*알려\s*드릴게요))$/u;
const englishStatusOnly = /^(?:(?:yes|sure|okay|ok|of course)[\s,.!]+)*(?:one moment|(?:please )?(?:hold on|wait a moment)|(?:i'll|i will|let me) (?:check(?: it| that| for you)?|look (?:into it|into that|it up|that up))(?: and (?:get back to you|let you know))?)$/i;

export function completeSpokenReply(text, { toolRun = false } = {}) {
  const body = text.trim().replace(/[.!?…。！？]+$/u, "").trimEnd().replaceAll("’", "'");
  if (koreanStatusOnly.test(body)) {
    if (toolRun) return "이번 요청에서 확인된 결과를 받지 못했어요. OpenClaw에서 실행 상태와 도구 권한을 확인해 주세요.";
    return "이 통화에서 외부 서비스의 상태를 직접 확인할 수는 없어요. 확인할 항목을 알려주시면 지금 안내해 드릴게요.";
  }
  if (englishStatusOnly.test(body)) {
    if (toolRun) return "I didn't get a confirmed result for this request. Check the run status and tool permissions in OpenClaw.";
    return "I can’t check external services from this call. Tell me what you’d like to verify, and I can walk you through it now.";
  }
  return text;
}
