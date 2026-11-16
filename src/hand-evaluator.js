const RANK_VALUE = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const CATEGORY_NAMES = [
  "High card",
  "One pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush",
];

function combinations(items, choose) {
  const result = [];
  const build = (start, selected) => {
    if (selected.length === choose) {
      result.push(selected);
      return;
    }
    for (let index = start; index <= items.length - (choose - selected.length); index += 1) {
      build(index + 1, [...selected, items[index]]);
    }
  };
  build(0, []);
  return result;
}

function compareScore(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function straightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    const run = unique.slice(index, index + 5);
    if (run.every((value, offset) => value === run[0] - offset)) return run[0];
  }
  return null;
}

export function evaluateFive(cards) {
  if (cards.length !== 5) throw new Error("evaluateFive requires exactly five cards");

  const values = cards.map((card) => RANK_VALUE[card[0]]).sort((a, b) => b - a);
  const suits = cards.map((card) => card[1]);
  const flush = suits.every((suit) => suit === suits[0]);
  const straight = straightHigh(values);

  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]);

  let score;
  if (flush && straight) {
    score = [8, straight];
  } else if (groups[0][1] === 4) {
    score = [7, groups[0][0], groups.find((group) => group[1] === 1)[0]];
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    score = [6, groups[0][0], groups[1][0]];
  } else if (flush) {
    score = [5, ...values];
  } else if (straight) {
    score = [4, straight];
  } else if (groups[0][1] === 3) {
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a);
    score = [3, groups[0][0], ...kickers];
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = groups.filter((group) => group[1] === 2).map((group) => group[0]).sort((a, b) => b - a);
    const kicker = groups.find((group) => group[1] === 1)[0];
    score = [2, ...pairs, kicker];
  } else if (groups[0][1] === 2) {
    const pair = groups[0][0];
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a);
    score = [1, pair, ...kickers];
  } else {
    score = [0, ...values];
  }

  return {
    score,
    category: score[0],
    description: CATEGORY_NAMES[score[0]],
    cards: [...cards],
  };
}

export function evaluateBest(cards) {
  if (cards.length < 5 || cards.length > 7) throw new Error("evaluateBest requires five to seven cards");
  let best = null;
  for (const candidate of combinations(cards, 5)) {
    const evaluation = evaluateFive(candidate);
    if (!best || compareScore(evaluation.score, best.score) > 0) best = evaluation;
  }
  return best;
}

export function compareEvaluations(left, right) {
  return compareScore(left.score, right.score);
}

function clockwiseWinners(winnerSeats, dealerIndex, seatCount) {
  const winnerSet = new Set(winnerSeats);
  const ordered = [];
  for (let offset = 1; offset <= seatCount; offset += 1) {
    const seat = (dealerIndex + offset + seatCount) % seatCount;
    if (winnerSet.has(seat)) ordered.push(seat);
  }
  return ordered;
}

export function resolveSidePots(players, communityCards, dealerIndex) {
  const contributionLevels = [...new Set(players.map((player) => player.totalCommitted).filter((amount) => amount > 0))]
    .sort((left, right) => left - right);
  const payouts = Object.fromEntries(players.map((player) => [player.seat, 0]));
  const evaluations = new Map();
  const pots = [];
  let previousLevel = 0;

  for (const level of contributionLevels) {
    const contributors = players.filter((player) => player.totalCommitted >= level);
    const perContributor = level - previousLevel;
    const amount = perContributor * contributors.length;
    previousLevel = level;
    if (amount <= 0) continue;

    const eligible = contributors.filter((player) => player.inHand && !player.folded);
    if (!eligible.length) {
      // No live player can contest this layer, so it was never called. Return each
      // contributor's chips instead of dropping them, which would destroy chips.
      for (const player of contributors) payouts[player.seat] += perContributor;
      continue;
    }
    for (const player of eligible) {
      if (!evaluations.has(player.seat)) {
        evaluations.set(player.seat, evaluateBest([...player.holeCards, ...communityCards]));
      }
    }

    let best = evaluations.get(eligible[0].seat);
    let winners = [eligible[0].seat];
    for (const player of eligible.slice(1)) {
      const comparison = compareEvaluations(evaluations.get(player.seat), best);
      if (comparison > 0) {
        best = evaluations.get(player.seat);
        winners = [player.seat];
      } else if (comparison === 0) {
        winners.push(player.seat);
      }
    }

    const orderedWinners = clockwiseWinners(winners, dealerIndex, players.length);
    const share = Math.floor(amount / orderedWinners.length);
    let remainder = amount % orderedWinners.length;
    for (const seat of orderedWinners) {
      payouts[seat] += share + (remainder > 0 ? 1 : 0);
      remainder -= remainder > 0 ? 1 : 0;
    }
    pots.push({ amount, winners: orderedWinners, description: best.description });
  }

  return { payouts, evaluations, pots };
}

