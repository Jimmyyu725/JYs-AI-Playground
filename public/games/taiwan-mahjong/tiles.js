// SVG faces for the 144 Taiwan Mahjong tiles. Each face is drawn in a 60x80 box so it
// scales from the phone river (about 18px wide) to the hand (about 56px wide).

const NUMERALS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const HONORS = {
  EW: { glyph: "東", color: "#1d1a16", name: "East" },
  SW: { glyph: "南", color: "#1d1a16", name: "South" },
  WW: { glyph: "西", color: "#1d1a16", name: "West" },
  NW: { glyph: "北", color: "#1d1a16", name: "North" },
  RD: { glyph: "中", color: "#c4302b", name: "Red dragon" },
  GD: { glyph: "發", color: "#17734a", name: "Green dragon" },
};
const FLOWERS = [
  ["梅", "Plum"], ["蘭", "Orchid"], ["菊", "Chrysanthemum"], ["竹", "Bamboo"],
  ["春", "Spring"], ["夏", "Summer"], ["秋", "Autumn"], ["冬", "Winter"],
];
const BLUE = "#1f4f9c";
const GREEN = "#17734a";
const RED = "#c4302b";
const INK = "#1d1a16";
const CJK = "'Noto Sans TC','ZCOOL QingKe HuangYou',serif";

const DOTS = {
  1: [[30, 40, 19]],
  2: [[30, 21, 12], [30, 59, 12]],
  3: [[14, 15, 10], [30, 40, 10], [46, 65, 10]],
  4: [[18, 23, 11], [42, 23, 11], [18, 57, 11], [42, 57, 11]],
  5: [[16, 17, 10], [44, 17, 10], [30, 40, 10], [16, 63, 10], [44, 63, 10]],
  6: [[19, 15, 9], [41, 15, 9], [19, 42, 9], [41, 42, 9], [19, 65, 9], [41, 65, 9]],
  7: [[13, 11, 7.5], [30, 20, 7.5], [47, 29, 7.5], [19, 48, 8], [41, 48, 8], [19, 67, 8], [41, 67, 8]],
  8: [[19, 11, 8], [41, 11, 8], [19, 30, 8], [41, 30, 8], [19, 50, 8], [41, 50, 8], [19, 69, 8], [41, 69, 8]],
  9: [[13, 15, 8], [30, 15, 8], [47, 15, 8], [13, 40, 8], [30, 40, 8], [47, 40, 8], [13, 65, 8], [30, 65, 8], [47, 65, 8]],
};
function dotColor(rank, index) {
  if (rank === 1) return RED;
  if (rank === 2) return [GREEN, BLUE][index];
  if (rank === 3) return [BLUE, RED, GREEN][index];
  if (rank === 4) return [BLUE, GREEN, GREEN, BLUE][index];
  if (rank === 5) return index === 2 ? RED : index % 3 === 0 ? BLUE : GREEN;
  if (rank === 6) return index < 2 ? GREEN : RED;
  if (rank === 7) return index < 3 ? GREEN : RED;
  if (rank === 8) return BLUE;
  return [BLUE, BLUE, BLUE, RED, RED, RED, GREEN, GREEN, GREEN][index];
}
function dot(x, y, r, color) {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="${(r * 0.28).toFixed(1)}"/>`
    + `<circle cx="${x}" cy="${y}" r="${(r * 0.55).toFixed(1)}" fill="${color}"/>`
    + `<circle cx="${x}" cy="${y}" r="${(r * 0.2).toFixed(1)}" fill="#efe2c4"/>`;
}

// Bamboo: [x, y, color] stick centres, stick height h.
const BAMBOO = {
  2: { h: 26, at: [[30, 22, GREEN], [30, 58, BLUE]] },
  3: { h: 26, at: [[30, 22, GREEN], [18, 58, BLUE], [42, 58, BLUE]] },
  4: { h: 26, at: [[18, 22, GREEN], [42, 22, BLUE], [18, 58, BLUE], [42, 58, GREEN]] },
  5: { h: 24, at: [[15, 20, GREEN], [45, 20, BLUE], [30, 40, RED], [15, 60, BLUE], [45, 60, GREEN]] },
  6: { h: 26, at: [[14, 22, GREEN], [30, 22, GREEN], [46, 22, GREEN], [14, 58, BLUE], [30, 58, BLUE], [46, 58, BLUE]] },
  7: { h: 20, at: [[30, 13, RED], [14, 40, GREEN], [30, 40, BLUE], [46, 40, GREEN], [14, 66, GREEN], [30, 66, BLUE], [46, 66, GREEN]] },
  8: { h: 26, at: [[11, 22, GREEN], [24, 22, BLUE], [37, 22, BLUE], [50, 22, GREEN], [11, 58, GREEN], [24, 58, BLUE], [37, 58, BLUE], [50, 58, GREEN]] },
  9: { h: 20, at: [[14, 14, GREEN], [30, 14, RED], [46, 14, BLUE], [14, 40, GREEN], [30, 40, RED], [46, 40, BLUE], [14, 66, GREEN], [30, 66, RED], [46, 66, BLUE]] },
};
function stick(x, y, h, color) {
  const w = 6.5;
  return `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="3" fill="${color}"/>`
    + `<rect x="${x - w / 2 - 1}" y="${y - 1.2}" width="${w + 2}" height="2.4" rx="1.2" fill="${color}"/>`
    + `<line x1="${x}" y1="${y - h / 2 + 3}" x2="${x}" y2="${y + h / 2 - 3}" stroke="#efe2c4" stroke-width="1" opacity=".55"/>`;
}
// 1s: the traditional bird, simplified to a sparrow on a bamboo node.
const BIRD = `<g>
  <path d="M14 58 C 16 40, 30 30, 42 30 C 50 30, 52 38, 46 42 C 40 47, 32 50, 28 60 Z" fill="${GREEN}"/>
  <circle cx="44" cy="26" r="8" fill="${RED}"/>
  <path d="M51 25 L 58 27 L 51 29 Z" fill="#f2b04a"/>
  <circle cx="46" cy="24.5" r="1.6" fill="#efe2c4"/>
  <path d="M14 58 C 8 66, 10 72, 18 70 C 14 66, 18 62, 22 60 Z" fill="${BLUE}"/>
  <path d="M28 44 C 32 48, 36 50, 40 46" stroke="#efe2c4" stroke-width="1.6" fill="none" opacity=".6"/>
  <rect x="24" y="64" width="22" height="4" rx="2" fill="${GREEN}"/>
</g>`;

function text(glyph, { x = 30, y = 40, size = 44, color = INK, weight = 700 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${CJK}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="middle" dominant-baseline="central">${glyph}</text>`;
}

function faceBody(code) {
  if (HONORS[code]) return text(HONORS[code].glyph, { color: HONORS[code].color, size: 46 });
  if (code === "WD") {
    return `<rect x="11" y="13" width="38" height="54" rx="4" fill="none" stroke="${BLUE}" stroke-width="4"/>`
      + `<rect x="17" y="19" width="26" height="42" rx="2" fill="none" stroke="${BLUE}" stroke-width="1.6"/>`;
  }
  if (code[0] === "F") {
    const index = Number(code[1]) - 1;
    const color = index < 4 ? RED : BLUE;
    return text(FLOWERS[index][0], { color, size: 40, y: 44 })
      + text(String((index % 4) + 1), { x: 11, y: 12, size: 14, color: index < 4 ? GREEN : RED, weight: 600 })
      + `<path d="M44 10 q4 -4 8 0 q-4 4 -8 0 Z M48 6 q4 4 0 8 q-4 -4 0 -8 Z" fill="${color}" opacity=".8"/>`;
  }
  const rank = Number(code[0]);
  const suit = code[1];
  if (suit === "m") {
    return text(NUMERALS[rank], { y: 22, size: 30, color: INK }) + text("萬", { y: 58, size: 32, color: RED });
  }
  if (suit === "p") return DOTS[rank].map(([x, y, r], index) => dot(x, y, r, dotColor(rank, index))).join("");
  if (rank === 1) return BIRD;
  const { h, at } = BAMBOO[rank];
  return at.map(([x, y, color]) => stick(x, y, h, color)).join("");
}

const cache = new Map();
/** The SVG markup of a tile face (no frame; the frame is CSS). */
export function tileSVG(code) {
  if (!cache.has(code)) {
    cache.set(code, `<svg viewBox="0 0 60 80" aria-hidden="true" focusable="false">${faceBody(code)}</svg>`);
  }
  return cache.get(code);
}

export function tileName(code) {
  if (!code) return "hidden tile";
  if (HONORS[code]) return `${HONORS[code].name} ${HONORS[code].glyph}`;
  if (code === "WD") return "White dragon 白";
  if (code[0] === "F") {
    const [glyph, name] = FLOWERS[Number(code[1]) - 1];
    return `${name} ${glyph}`;
  }
  const rank = Number(code[0]);
  const suit = { m: ["Characters", "萬"], p: ["Dots", "筒"], s: ["Bamboo", "條"] }[code[1]];
  return `${rank} ${suit[0]} ${NUMERALS[rank]}${suit[1]}`;
}

/**
 * A tile element. `code` null renders a face-down jade back.
 * options: size (xs|sm|md|lg), tilt (deg), button (true for a clickable hand tile)
 */
export function tileElement(code, { size = "sm", tilt = 0, button = false, extraClass = "" } = {}) {
  const el = document.createElement(button ? "button" : "span");
  el.className = `mj-tile ${extraClass}`.trim();
  el.dataset.size = size;
  if (button) el.type = "button";
  if (tilt) el.style.setProperty("--tilt", `${tilt}deg`);
  if (code) {
    el.dataset.tile = code;
    el.innerHTML = tileSVG(code);
    el.setAttribute("aria-label", tileName(code));
    el.title = tileName(code);
  } else {
    el.classList.add("is-back");
    el.setAttribute("aria-label", "hidden tile");
  }
  return el;
}
