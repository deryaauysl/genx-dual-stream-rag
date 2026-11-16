// =============================================================================
// Node: "Intent Router"              (Code node - Run Once for Each Item)
// -----------------------------------------------------------------------------
// Runs before anything expensive. Normalises the incoming message from either
// trigger (Chat Trigger -> chatInput, Webhook -> body.message) and uses a regex
// to catch pure greetings ("Hi", "Hello Dr. Sara!", "good morning").
// Greetings never reach the embedder, the database or the LLM.
//
// "Hi, how do I delegate better?" is NOT a pure greeting -> it is a question.
// =============================================================================

const GREETING = /^\s*(hi+|hello+|hey+|hiya|howdy|yo|greetings|good\s+(morning|afternoon|evening|day)|merhaba|selam)\b[\s,!.]*((dr\.?\s*)?sara|there|team|everyone|all|coach)?[\s,!.?:)]*$/i;

const j = $json;
const message = String(j.chatInput ?? j.body?.message ?? j.body?.chatInput ?? j.message ?? j.query ?? '').trim();

let intent = 'question';
if (message === '') intent = 'empty';
else if (GREETING.test(message)) intent = 'greeting';

return {
  json: {
    message,
    intent,
    sessionId: j.sessionId ?? j.body?.sessionId ?? null,
  },
};
