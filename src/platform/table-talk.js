/**
 * Table talk: every AI decision may carry one optional, public, in-character line that the room
 * shows as a speech bubble. It is shaped by the character's `voice` and must never leak private
 * information (hole cards, a hand, hidden dice, plans).
 */
export const TABLE_TALK_MAX_LENGTH = 140;

export function tableTalkInstruction(voice) {
  const voiceLine = voice ? ` Your voice: ${String(voice).slice(0, 400)}` : "";
  return `\n\nTable talk: tableTalk is one optional line you say out loud to the table, in character, at most ${TABLE_TALK_MAX_LENGTH} characters.${voiceLine} Everyone hears it, so never reveal private information such as your cards, hand, hidden pieces, or exact plans; banter, needling, bravado, or reactions are fine. Use an empty string to stay silent, and stay silent more often than not.`;
}

/** Adds the required (possibly empty) tableTalk string to a strict structured-output schema. */
export function withTableTalk(schema) {
  return {
    ...schema,
    properties: { ...schema.properties, tableTalk: { type: "string", maxLength: TABLE_TALK_MAX_LENGTH } },
    required: [...schema.required, "tableTalk"],
  };
}

/** Returns a clean public line or null. */
export function cleanTableTalk(text) {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim().slice(0, TABLE_TALK_MAX_LENGTH);
  return line || null;
}

/** Appends a talk entry to a table (engine object) and returns it; keeps the last 30 lines. */
export function pushTableTalk(table, { speaker, playerName, characterId = null, text }) {
  const line = cleanTableTalk(text);
  if (!table || !line) return null;
  const entry = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, speaker, playerName, characterId, text: line, at: Date.now() };
  table.tableTalk = [...(table.tableTalk ?? []), entry].slice(-30);
  return entry;
}
