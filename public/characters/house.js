// The House: the full roster with personality, voice and a record built from recent ladder matches.
import { characterRecords, mergeMatches, numberWord } from "/assets/lobby/house-data.js";
import { el, getJSON, loadCast, mountHouseBar, portrait } from "/assets/lobby/house-ui.js";

const grid = document.querySelector("#cast-grid");
const search = document.querySelector("#cast-search");
const empty = document.querySelector("#cast-empty");
const note = document.querySelector("#cast-note");
let filter = "all";

/** The API only serves recent matches, so merge the overall list with every game's list for the widest window. */
async function recentMatches() {
  const overview = await getJSON("/api/ladder");
  const games = Object.keys(overview.games ?? {});
  const perGame = await Promise.all(games.map((gameId) => getJSON(`/api/ladder/${encodeURIComponent(gameId)}`).catch(() => null)));
  return mergeMatches(overview.recentMatches, ...perGame.map((ladder) => ladder?.recentMatches));
}

function recordLine(record, gameNames) {
  if (!record) return el("p", "card-record is-empty", "No recorded games yet");
  const line = el("p", "card-record");
  const tally = el("span", "card-tally");
  tally.append(el("b", null, String(record.wins)), " W · ", el("b", null, String(record.losses)), " L");
  if (record.draws) tally.append(" · ", el("b", null, String(record.draws)), " D");
  line.append(tally, el("span", "card-games", record.games.map((id) => gameNames[id] ?? id).join(" · ")));
  return line;
}

function card(character, record, gameNames, index) {
  const item = el("li", "cast-card");
  item.id = character.id;
  item.style.setProperty("--who", character.color);
  item.style.setProperty("--i", index % 12);
  item.dataset.search = [character.name, character.title, character.personality, character.voice].join(" ").toLowerCase();
  item.dataset.played = record ? "true" : "false";
  const body = el("div", "card-body");
  body.append(el("p", "card-title", character.title), el("h2", "card-name", character.name));
  if (character.personality) body.append(el("p", "card-personality", character.personality));
  if (character.voice) body.append(el("blockquote", "card-voice", character.voice));
  body.append(recordLine(record, gameNames));
  item.append(el("span", "card-number", String(index + 1).padStart(2, "0")), portrait(character), body);
  return item;
}

function applyFilter() {
  const query = search.value.trim().toLowerCase();
  let visible = 0;
  for (const item of grid.children) {
    const show = (!query || item.dataset.search.includes(query)) && (filter === "all" || item.dataset.played === "true");
    item.hidden = !show;
    if (show) visible += 1;
  }
  empty.hidden = visible > 0;
}

async function main() {
  mountHouseBar();
  const [cast, matches, catalog] = await Promise.all([
    loadCast(),
    recentMatches().catch(() => []),
    getJSON("/api/games").catch(() => ({ games: [] })),
  ]);
  const gameNames = Object.fromEntries(catalog.games.map((game) => [game.id, game.name]));
  const records = characterRecords(matches);
  grid.replaceChildren(...cast.map((character, index) => card(character, records[character.id], gameNames, index)));
  document.querySelector("#cast-count").textContent = numberWord(cast.length).toLowerCase();
  note.textContent = matches.length
    ? `Records count the ${matches.length} most recent matches the ladder keeps for each game.`
    : "Records appear once games finish and land on the ladder.";
  search.addEventListener("input", applyFilter);
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      filter = chip.dataset.filter;
      for (const other of document.querySelectorAll(".chip")) other.setAttribute("aria-pressed", String(other === chip));
      applyFilter();
    });
  }
  // Links like /characters/#vesper arrive before the cards exist; scroll once they do.
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: "center" });
}

main().catch(() => {
  grid.replaceChildren(el("li", "cast-empty", "The house could not be reached. Refresh to try again."));
});
