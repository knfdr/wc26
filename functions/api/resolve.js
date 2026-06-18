const GIST_ID = "8a76d2b09c709882e4364528a0152ccc";
const GIST_FILENAME = "sharpsim_bets.json";

const SPORT_CONFIG = {
  WC:   { key: "soccer_fifa_world_cup", daysFrom: 4 },
  MLB:  { key: "baseball_mlb",          daysFrom: 3 },
  WNBA: { key: "basketball_wnba",       daysFrom: 3 },
};

// Scores that have aged out of the Odds API window
const FALLBACK_GAMES = {
  "ger-crc": { home_team:"Germany",     away_team:"Curacao",       completed:true, scores:[{name:"Germany",score:"7"},{name:"Curacao",score:"1"}],       h1Home:3, h1Away:1 },
  "ned-jpn": { home_team:"Netherlands", away_team:"Japan",         completed:true, scores:[{name:"Netherlands",score:"2"},{name:"Japan",score:"2"}],       h1Home:0, h1Away:0 },
  "aut-jor": { home_team:"Austria",     away_team:"Jordan",        completed:true, scores:[{name:"Austria",score:"3"},{name:"Jordan",score:"1"}],          h1Home:1, h1Away:0 },
  "por-cod": { home_team:"Portugal",    away_team:"DR Congo",      completed:true, scores:[{name:"Portugal",score:"1"},{name:"DR Congo",score:"1"}],       h1Home:1, h1Away:1 },
  "eng-cro": { home_team:"England",     away_team:"Croatia",       completed:true, scores:[{name:"England",score:"4"},{name:"Croatia",score:"2"}],         h1Home:2, h1Away:2 },
  "gha-pan": { home_team:"Ghana",       away_team:"Panama",        completed:true, scores:[{name:"Ghana",score:"1"},{name:"Panama",score:"0"}],            h1Home:0, h1Away:0 },
  "uzb-col": { home_team:"Uzbekistan",  away_team:"Colombia",      completed:true, scores:[{name:"Uzbekistan",score:"1"},{name:"Colombia",score:"3"}],     h1Home:0, h1Away:1 },
};

function normName(n) {
  return n.replace("Congo DR", "DR Congo").replace("Curaçao", "Curacao");
}

function resolveBet(bet, game) {
  const homeScore = parseInt((game.scores.find(s => s.name === game.home_team) || {}).score || "0");
  const awayScore = parseInt((game.scores.find(s => s.name !== game.home_team) || {}).score || "0");
  const h1Home = game.h1Home ?? null;
  const h1Away = game.h1Away ?? null;

  let result = "loss";
  const market = bet.market.toLowerCase();

  if (market.includes("corners")) {
    result = "push";
  } else if (market.includes("1h over") || market.includes("1h under")) {
    const line = parseFloat(bet.market.match(/[\d.]+/)?.[0] || "0");
    const h1Total = h1Home != null ? h1Home + h1Away : homeScore + awayScore;
    if (market.includes("1h over"))  result = h1Total > line ? "win" : h1Total === line ? "push" : "loss";
    else                              result = h1Total < line ? "win" : h1Total === line ? "push" : "loss";
  } else if (market.includes("ht win") || market.includes("halftime")) {
    const h1H = h1Home ?? homeScore;
    const h1A = h1Away ?? awayScore;
    const pickedHome = bet.market.toLowerCase().includes(game.home_team.toLowerCase());
    if      (pickedHome  && h1H > h1A) result = "win";
    else if (!pickedHome && h1A > h1H) result = "win";
    else if (h1H === h1A)              result = "push";
  } else if (market.includes("1h") && market.includes("spread")) {
    const h1H = h1Home ?? homeScore;
    const h1A = h1Away ?? awayScore;
    const pickedHome = bet.market.toLowerCase().includes(game.home_team.toLowerCase());
    if      (pickedHome  && h1H > h1A) result = "win";
    else if (!pickedHome && h1A > h1H) result = "win";
    else if (h1H === h1A)              result = "push";
  } else if (market.includes("nrfi")) {
    result = (homeScore === 0 && awayScore === 0) ? "win" : "loss";
  } else if (market.includes("yrfi")) {
    result = (homeScore > 0 || awayScore > 0) ? "win" : "loss";
  } else if (market.includes("-1.5") || market.includes("run line")) {
    const pickedHome = bet.market.includes(game.home_team);
    if      (pickedHome  && (homeScore - awayScore) >= 2) result = "win";
    else if (!pickedHome && (awayScore - homeScore) >= 2) result = "win";
  } else if (market.includes("ml") || market.includes(" win") || market.includes("moneyline")) {
    const pickedHome = bet.market.toLowerCase().includes(game.home_team.toLowerCase());
    if      (pickedHome  && homeScore > awayScore) result = "win";
    else if (!pickedHome && awayScore > homeScore) result = "win";
    else if (homeScore === awayScore)              result = "push";
  } else if (market.includes("over")) {
    const line = parseFloat(bet.market.match(/[\d.]+/)?.[0] || "0");
    if      (homeScore + awayScore > line) result = "win";
    else if (homeScore + awayScore === line) result = "push";
  } else if (market.includes("under")) {
    const line = parseFloat(bet.market.match(/[\d.]+/)?.[0] || "0");
    if      (homeScore + awayScore < line) result = "win";
    else if (homeScore + awayScore === line) result = "push";
  } else {
    // Spread: "{team} -X.5" or "{team} +X.5"
    const pointMatch = bet.market.match(/([+-][\d.]+)$/);
    if (pointMatch) {
      const point = parseFloat(pointMatch[1]);
      const pickedHome = bet.market.includes(game.home_team);
      const margin = homeScore - awayScore;
      const adj = pickedHome ? margin + point : -margin + (-point);
      if      (adj > 0) result = "win";
      else if (adj === 0) result = "push";
    }
  }

  return { ...bet, result, resolvedAt: new Date().toISOString(), finalScore: homeScore + "-" + awayScore };
}

export async function onRequest(context) {
  const { ODDS_API_KEY, GITHUB_TOKEN } = context.env;

  // Read gist
  const gistRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "User-Agent": "wc26-proxy" },
  });
  if (!gistRes.ok) return new Response("Gist read failed", { status: 500 });
  const gistData = await gistRes.json();
  const content = gistData.files[GIST_FILENAME]?.content || "[]";
  const bets = JSON.parse(content);

  const pending = bets.filter(b => b.result === "pending");
  if (!pending.length) {
    return new Response(JSON.stringify(bets), { headers: { "Content-Type": "application/json" } });
  }

  // Fetch scores for every sport that has pending bets
  const sports = [...new Set(pending.map(b => b.sport))];
  const scoreMap = {};

  for (const sport of sports) {
    const cfg = SPORT_CONFIG[sport];
    if (!cfg) continue;
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${cfg.key}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=${cfg.daysFrom}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const scores = await res.json();
      scores.forEach(g => {
        if (g.completed !== true || !g.scores?.length) return;
        if (Date.now() - new Date(g.commence_time).getTime() < 3 * 60 * 60 * 1000) return;
        const h = normName(g.home_team);
        const a = normName(g.away_team);
        const normalized = { ...g, home_team: h, away_team: a };
        scoreMap[g.id]       = normalized;
        scoreMap[h + "|" + a] = normalized;
        scoreMap[a + "|" + h] = normalized;
      });
    } catch(e) {}
  }

  // Resolve
  const resolved = bets.map(bet => {
    if (bet.result !== "pending") return bet;

    let game = scoreMap[bet.gameId]
      || scoreMap[bet.homeTeam + "|" + bet.awayTeam]
      || FALLBACK_GAMES[bet.gameId];

    if (!game?.completed) return bet;

    // Prevent cross-day false matches: bet date must match game date
    if (bet.gameDate && game.commence_time) {
      const gameDate = new Date(game.commence_time).toISOString().slice(0, 10);
      if (gameDate !== bet.gameDate) return bet;
    }

    return resolveBet(bet, game);
  });

  // Write back only if something changed
  const changed = resolved.some((b, i) => b.result !== bets[i].result);
  if (changed) {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json", "User-Agent": "wc26-proxy" },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(resolved, null, 2) } } }),
    });
  }

  return new Response(JSON.stringify(resolved), { headers: { "Content-Type": "application/json" } });
}
