// The model ladder: Elo standings, a rating trend (per game) or room activity (overall), and recent matches.
import { entrantKey, entrantLabel, isOpen, ratingPaths, relativeTime, roomLight } from "/assets/lobby/house-data.js";
import { el, getJSON, loadCast, mountHouseBar, swap } from "/assets/lobby/house-ui.js";

const SVG = "http://www.w3.org/2000/svg";
const LINE_COLORS = ["#b4bfff", "#ffd9a6", "#8ff0d0", "#ff9fc8", "#f6b545", "#9fd4ff"];
const BASELINE = 1500;

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function providerOf(entry, registry) {
  if (entry.kind === "human") return "human";
  return registry.models?.find((model) => model.id === entry.model)?.provider ?? "other";
}

/** One row per entrant: label, a bar diverging from 1500, rating and record. */
function standings(ratings, registry) {
  if (!ratings.length) return el("p", "chart-empty", "Nobody has finished a game here yet.");
  const spread = Math.max(60, ...ratings.map((entry) => Math.abs(entry.rating - BASELINE))) * 1.1;
  const list = el("ol", "standings-list");
  ratings.forEach((entry, index) => {
    const row = el("li", "standing");
    row.dataset.provider = providerOf(entry, registry);
    const bar = svg("svg", { viewBox: "0 0 200 12", preserveAspectRatio: "none", class: "standing-bar", "aria-hidden": "true" });
    const width = (Math.abs(entry.rating - BASELINE) / spread) * 100;
    const x = entry.rating >= BASELINE ? 100 : 100 - width;
    bar.append(
      svg("rect", { x: 0, y: 5.5, width: 200, height: 1, class: "bar-track" }),
      svg("rect", { x, y: 1, width: Math.max(width, 0.8), height: 10, rx: 2, class: entry.rating >= BASELINE ? "bar-up" : "bar-down" }),
      svg("rect", { x: 99.6, y: 0, width: 0.8, height: 12, class: "bar-zero" }),
    );
    const record = `${entry.wins}W ${entry.losses}L${entry.draws ? ` ${entry.draws}D` : ""}`;
    row.append(
      el("span", "standing-rank", String(index + 1)),
      el("span", "standing-who", entrantLabel(entry, registry)),
      bar,
      el("span", "standing-rating", String(entry.rating)),
      el("span", "standing-record", record),
    );
    list.append(row);
  });
  return list;
}

function niceTicks(min, max, count = 4) {
  const step = [5, 10, 20, 25, 50, 100, 200].find((candidate) => (max - min) / candidate <= count) ?? 500;
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) ticks.push(value);
  return ticks;
}

/** Rating paths of the top six entrants over this game's recent matches, aligned so every path ends "now". */
function trend(ladder, registry, width = 600) {
  const top = ladder.ratings.slice(0, 6);
  const paths = ratingPaths(ladder.ratings, ladder.recentMatches);
  const series = top.map((entry, index) => ({ entry, color: LINE_COLORS[index], points: paths[entry.key] ?? [entry.rating] }));
  const length = Math.max(2, ...series.map((line) => line.points.length));
  const values = series.flatMap((line) => line.points).concat(BASELINE);
  const low = Math.min(...values) - 8;
  const high = Math.max(...values) + 8;
  const W = Math.round(Math.min(600, Math.max(300, width)));
  const H = Math.round(W * 0.42);
  const pad = { left: 40, right: 12, top: 12, bottom: 22 };
  const x = (index) => pad.left + (index / (length - 1)) * (W - pad.left - pad.right);
  const y = (value) => pad.top + (1 - (value - low) / (high - low)) * (H - pad.top - pad.bottom);
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "trend-svg", role: "img", "aria-label": "Rating over recent matches" });
  for (const tick of niceTicks(low, high)) {
    chart.append(
      svg("line", { x1: pad.left, x2: W - pad.right, y1: y(tick), y2: y(tick), class: tick === BASELINE ? "grid grid-base" : "grid" }),
      Object.assign(svg("text", { x: pad.left - 8, y: y(tick) + 4, class: "tick", "text-anchor": "end" }), { textContent: String(tick) }),
    );
  }
  chart.append(Object.assign(svg("text", { x: W - pad.right, y: H - 4, class: "tick", "text-anchor": "end" }), { textContent: "now" }));
  chart.append(Object.assign(svg("text", { x: pad.left, y: H - 4, class: "tick" }), { textContent: `${length - 1} matches ago` }));
  for (const line of series) {
    const offset = length - line.points.length;
    const d = line.points.map((value, index) => `${index ? "L" : "M"}${x(index + offset).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
    chart.append(svg("path", { d, class: "trend-line", stroke: line.color, pathLength: 1 }));
    const last = line.points.at(-1);
    chart.append(svg("circle", { cx: x(length - 1), cy: y(last), r: 4, fill: line.color, class: "trend-dot" }));
  }
  const legend = el("ul", "legend");
  for (const line of series) {
    const item = el("li", null, entrantLabel(line.entry, registry));
    item.style.setProperty("--series", line.color);
    legend.append(item);
  }
  const wrap = el("div", "trend-wrap");
  wrap.append(chart, legend);
  return wrap;
}

/** Overall view: how many recorded matches each room has, one bar per room in that room's own light. */
function roomActivity(counts, catalog) {
  const rows = catalog.games
    .map((game) => [game.id, counts[game.id] ?? 0, game])
    .filter(([, count, game]) => isOpen(game) || count > 0);
  const max = Math.max(1, ...rows.map(([, count]) => count));
  const list = el("ol", "rooms-list");
  list.setAttribute("aria-label", "Recorded matches by room");
  for (const [gameId, count, game] of rows) {
    const row = el("li", "room-row");
    row.style.setProperty("--glow", roomLight(gameId).glow);
    const bar = svg("svg", { viewBox: "0 0 100 10", preserveAspectRatio: "none", class: "room-svg", "aria-hidden": "true" });
    bar.append(
      svg("rect", { x: 0, y: 0, width: 100, height: 10, rx: 5, class: "room-track" }),
      svg("rect", { x: 0, y: 0, width: count ? Math.max((count / max) * 100, 4) : 0, height: 10, rx: 5, class: "room-bar" }),
    );
    row.append(el("span", "room-label", game.name), bar, el("span", "room-count", String(count)));
    list.append(row);
  }
  return list;
}

function matchItem(match, { cast, registry, catalog }) {
  const game = catalog.games.find((candidate) => candidate.id === match.gameId);
  const item = el("li", "match");
  item.style.setProperty("--glow", roomLight(match.gameId).glow);
  const head = el("p", "match-head");
  head.append(
    el("strong", "match-room", game?.name ?? match.gameId),
    el("span", "match-mode", match.mode === "arena" ? "Arena" : "vs human"),
    el("time", "match-time", relativeTime(match.at)),
  );
  head.querySelector("time").dateTime = match.at;
  const seats = el("ol", "match-seats");
  match.participants
    .map((participant, index) => ({ participant, rank: match.ranks?.[index] ?? index + 1 }))
    .sort((a, b) => a.rank - b.rank)
    .forEach(({ participant, rank }) => {
      const character = cast.find((candidate) => candidate.id === participant.characterId);
      const seat = el("li", "match-seat");
      seat.style.setProperty("--who", character?.color ?? "var(--lamp)");
      const change = match.ratingChanges?.[entrantKey(participant)];
      const delta = el("span", "match-delta", change == null ? "" : `${change > 0 ? "+" : ""}${Math.round(change)}`);
      if (change > 0) delta.dataset.sign = "up";
      if (change < 0) delta.dataset.sign = "down";
      seat.append(
        el("span", "match-rank", String(rank)),
        el("span", "match-who", participant.kind === "human" ? participant.name || "You" : character?.shortName ?? participant.name),
        el("span", "match-model", participant.kind === "human" ? "Human" : entrantLabel(participant, registry)),
        delta,
      );
      seats.append(seat);
    });
  item.append(head, seats);
  return item;
}

async function main() {
  mountHouseBar();
  const [overview, registry, catalog, cast] = await Promise.all([
    getJSON("/api/ladder"),
    getJSON("/api/models"),
    getJSON("/api/games"),
    loadCast().catch(() => []),
  ]);
  const playedGames = Object.keys(overview.games ?? {});
  const tabs = ["overall", ...catalog.games.filter((game) => isOpen(game) || playedGames.includes(game.id)).map((game) => game.id)];
  const gameLadders = Object.fromEntries(
    await Promise.all(playedGames.map(async (gameId) => [gameId, await getJSON(`/api/ladder/${encodeURIComponent(gameId)}`)])),
  );
  const perGameCounts = Object.fromEntries(playedGames.map((gameId) => [gameId, gameLadders[gameId].matchCount]));
  document.querySelector("#match-count").textContent = overview.matchCount ? String(overview.matchCount) : "no";

  const leader = overview.overall.find((entry) => entry.kind !== "human");
  document.querySelector("#leader-rating").textContent = String(leader?.rating ?? BASELINE);
  document.querySelector("#leader-name").textContent = leader ? entrantLabel(leader, registry) : "Unclaimed";
  document.querySelector("#leader-record").textContent = leader
    ? `${leader.wins} wins · ${leader.losses} losses${leader.draws ? ` · ${leader.draws} draws` : ""} across ${leader.matches} matches`
    : "The first model to win a game here takes the plaque.";
  document.querySelector("#leader").hidden = false;

  const tabRow = document.querySelector("#ladder-tabs");
  const nameOf = (id) => (id === "overall" ? "Overall" : catalog.games.find((game) => game.id === id)?.name ?? id);
  for (const id of tabs) {
    const tab = el("button", "chip", nameOf(id));
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.dataset.tab = id;
    if (id !== "overall") tab.style.setProperty("--glow", roomLight(id).glow);
    tab.addEventListener("click", () => {
      history.replaceState(null, "", id === "overall" ? location.pathname : `#${id}`);
      swap(() => show(id));
    });
    tabRow.append(tab);
  }

  const context = { cast, registry, catalog };
  function show(id) {
    for (const tab of tabRow.children) tab.setAttribute("aria-selected", String(tab.dataset.tab === id));
    for (const tab of tabRow.children) tab.setAttribute("aria-pressed", String(tab.dataset.tab === id));
    const isOverall = id === "overall";
    const ladder = isOverall ? null : gameLadders[id] ?? { ratings: [], recentMatches: [], matchCount: 0 };
    const ratings = isOverall ? overview.overall : ladder.ratings;
    const matches = isOverall ? overview.recentMatches : ladder.recentMatches;
    document.querySelector("#standings-title").textContent = isOverall ? "Overall standings" : `${nameOf(id)} standings`;
    document.querySelector("#standings-note").textContent = isOverall
      ? "Every game counts. Bars run from 1500."
      : `${ladder.matchCount} recorded ${ladder.matchCount === 1 ? "match" : "matches"}. Bars run from 1500.`;
    document.querySelector("#standings-chart").replaceChildren(standings(ratings, registry));
    document.querySelector("#trend-title").textContent = isOverall ? "Matches by room" : "Rating over recent matches";
    document.querySelector("#trend-note").textContent = isOverall ? "Recorded matches in each room." : "The top six entrants, newest on the right.";
    document.querySelector("#trend-chart").replaceChildren(
      isOverall
        ? roomActivity(perGameCounts, catalog)
        : ladder.ratings.length
          ? trend(ladder, registry, document.querySelector("#trend-chart").clientWidth)
          : el("p", "chart-empty", "The trend appears after the first finished game."),
    );
    document.querySelector("#recent-note").textContent = matches.length ? `The last ${matches.length}, newest first.` : "";
    const list = document.querySelector("#match-list");
    list.replaceChildren(...matches.map((match) => matchItem(match, context)));
    if (!matches.length) list.replaceChildren(el("li", "chart-empty", "No matches yet. Finish a game in any room and it appears here."));
  }

  const fromHash = decodeURIComponent(location.hash.slice(1));
  show(tabs.includes(fromHash) ? fromHash : "overall");
}

main().catch(() => {
  document.querySelector("#standings-chart").replaceChildren(el("p", "chart-empty", "The ladder could not be reached. Refresh to try again."));
});
