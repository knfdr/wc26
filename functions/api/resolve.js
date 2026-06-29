const GIST_ID = "8a76d2b09c709882e4364528a0152ccc";
const GIST_FILENAME = "sharpsim_bets.json";

const SPORT_CONFIG = {
  WC:   { key: "soccer_fifa_world_cup", daysFrom: 3 },
  MLB:  { key: "baseball_mlb",          daysFrom: 3 },
  WNBA: { key: "basketball_wnba",       daysFrom: 3 },
};

// Scores that have aged out of the Odds API window
const FALLBACK_GAMES = {
  // Pre-tracking MD1 games
  "ger-crc": { home_team:"Germany",     away_team:"Curacao",       completed:true, scores:[{name:"Germany",score:"7"},{name:"Curacao",score:"1"}],       h1Home:3, h1Away:1 },
  "ned-jpn": { home_team:"Netherlands", away_team:"Japan",         completed:true, scores:[{name:"Netherlands",score:"2"},{name:"Japan",score:"2"}],       h1Home:0, h1Away:0 },
  "aut-jor": { home_team:"Austria",     away_team:"Jordan",        completed:true, scores:[{name:"Austria",score:"3"},{name:"Jordan",score:"1"}],          h1Home:1, h1Away:0 },
  "por-cod": { home_team:"Portugal",    away_team:"DR Congo",      completed:true, scores:[{name:"Portugal",score:"1"},{name:"DR Congo",score:"1"}],       h1Home:1, h1Away:1 },
  "eng-cro": { home_team:"England",     away_team:"Croatia",       completed:true, scores:[{name:"England",score:"4"},{name:"Croatia",score:"2"}],         h1Home:2, h1Away:2 },
  "gha-pan": { home_team:"Ghana",       away_team:"Panama",        completed:true, scores:[{name:"Ghana",score:"1"},{name:"Panama",score:"0"}],            h1Home:0, h1Away:0 },
  "uzb-col": { home_team:"Uzbekistan",  away_team:"Colombia",      completed:true, scores:[{name:"Uzbekistan",score:"1"},{name:"Colombia",score:"3"}],     h1Home:0, h1Away:1 },
  // 6/19 MD1 games
  "usa-aus": { home_team:"USA",         away_team:"Australia",     completed:true, scores:[{name:"USA",score:"2"},{name:"Australia",score:"0"}],           h1Home:1, h1Away:0 },
  "sco-mor": { home_team:"Scotland",    away_team:"Morocco",       completed:true, scores:[{name:"Scotland",score:"0"},{name:"Morocco",score:"1"}],        h1Home:0, h1Away:0 },
  "bra-hai": { home_team:"Brazil",      away_team:"Haiti",         completed:true, scores:[{name:"Brazil",score:"3"},{name:"Haiti",score:"0"}],            h1Home:2, h1Away:0 },
  "tur-par": { home_team:"Turkey",      away_team:"Paraguay",      completed:true, scores:[{name:"Turkey",score:"0"},{name:"Paraguay",score:"1"}],         h1Home:0, h1Away:0 },
  // 6/20 MD1 games
  "ned-swe": { home_team:"Netherlands", away_team:"Sweden",        completed:true, scores:[{name:"Netherlands",score:"5"},{name:"Sweden",score:"1"}],      h1Home:2, h1Away:0 },
  "ger-civ": { home_team:"Germany",     away_team:"Ivory Coast",   completed:true, scores:[{name:"Germany",score:"2"},{name:"Ivory Coast",score:"1"}],     h1Home:1, h1Away:1 },
  "ecu-cuw": { home_team:"Ecuador",     away_team:"Curacao",       completed:true, scores:[{name:"Ecuador",score:"0"},{name:"Curacao",score:"0"}],         h1Home:0, h1Away:0 },
  "tun-jpn": { home_team:"Tunisia",     away_team:"Japan",         completed:true, scores:[{name:"Tunisia",score:"0"},{name:"Japan",score:"4"}],           h1Home:0, h1Away:2 },
  // 6/21 MD1 games
  "esp-ksa": { home_team:"Spain",       away_team:"Saudi Arabia",  completed:true, scores:[{name:"Spain",score:"4"},{name:"Saudi Arabia",score:"0"}],      h1Home:2, h1Away:0 },
  "bel-iri": { home_team:"Belgium",     away_team:"Iran",          completed:true, scores:[{name:"Belgium",score:"0"},{name:"Iran",score:"0"}],            h1Home:0, h1Away:0 },
  "uru-cpv": { home_team:"Uruguay",     away_team:"Cape Verde",    completed:true, scores:[{name:"Uruguay",score:"2"},{name:"Cape Verde",score:"2"}],      h1Home:1, h1Away:1 },
  "nzl-egy": { home_team:"New Zealand", away_team:"Egypt",         completed:true, scores:[{name:"New Zealand",score:"1"},{name:"Egypt",score:"3"}],       h1Home:0, h1Away:1 },
  // 6/22 MD1 games
  "arg-aut": { home_team:"Argentina",   away_team:"Austria",       completed:true, scores:[{name:"Argentina",score:"2"},{name:"Austria",score:"0"}],       h1Home:1, h1Away:0 },
  "fra-irq": { home_team:"France",      away_team:"Iraq",          completed:true, scores:[{name:"France",score:"3"},{name:"Iraq",score:"0"}],             h1Home:2, h1Away:0 },
  "nor-sen": { home_team:"Norway",      away_team:"Senegal",       completed:true, scores:[{name:"Norway",score:"3"},{name:"Senegal",score:"2"}],          h1Home:2, h1Away:1 },
  "jor-alg": { home_team:"Jordan",      away_team:"Algeria",       completed:true, scores:[{name:"Jordan",score:"1"},{name:"Algeria",score:"2"}],          h1Home:0, h1Away:1 },
  // 6/23 MD2 games
  "por-uzb": { home_team:"Portugal",    away_team:"Uzbekistan",    completed:true, scores:[{name:"Portugal",score:"5"},{name:"Uzbekistan",score:"0"}],     h1Home:2, h1Away:0 },
  "eng-gha": { home_team:"England",     away_team:"Ghana",         completed:true, scores:[{name:"England",score:"0"},{name:"Ghana",score:"0"}],           h1Home:0, h1Away:0 },
  "pan-cro": { home_team:"Panama",      away_team:"Croatia",       completed:true, scores:[{name:"Panama",score:"0"},{name:"Croatia",score:"1"}],          h1Home:0, h1Away:0 },
  "col-cod": { home_team:"Colombia",    away_team:"DR Congo",      completed:true, scores:[{name:"Colombia",score:"1"},{name:"DR Congo",score:"0"}],       h1Home:1, h1Away:0 },
  // 6/24 MD3 games (Groups A, B, C)
  "cze-mex": { home_team:"Czech Republic", away_team:"Mexico",            completed:true, scores:[{name:"Czech Republic",score:"0"},{name:"Mexico",score:"3"}],          h1Home:0, h1Away:0 },
  "rsa-kor": { home_team:"South Africa",   away_team:"South Korea",       completed:true, scores:[{name:"South Africa",score:"1"},{name:"South Korea",score:"0"}],       h1Home:0, h1Away:0 },
  "sui-can": { home_team:"Switzerland",    away_team:"Canada",            completed:true, scores:[{name:"Switzerland",score:"3"},{name:"Canada",score:"1"}],             h1Home:1, h1Away:0 },
  "bih-qat": { home_team:"Bosnia & Herzegovina", away_team:"Qatar",       completed:true, scores:[{name:"Bosnia & Herzegovina",score:"3"},{name:"Qatar",score:"1"}],     h1Home:2, h1Away:1 },
  "sco-bra": { home_team:"Scotland",       away_team:"Brazil",            completed:true, scores:[{name:"Scotland",score:"0"},{name:"Brazil",score:"3"}],              h1Home:0, h1Away:2 },
  "mor-hai": { home_team:"Morocco",        away_team:"Haiti",             completed:true, scores:[{name:"Morocco",score:"4"},{name:"Haiti",score:"2"}],               h1Home:2, h1Away:1 },
  // 6/25 MD3 games (Groups D, E, F)
  "tur-usa": { home_team:"Turkey",         away_team:"USA",               completed:true, scores:[{name:"Turkey",score:"3"},{name:"USA",score:"2"}],                  h1Home:2, h1Away:1 },
  "par-aus": { home_team:"Paraguay",       away_team:"Australia",         completed:true, scores:[{name:"Paraguay",score:"0"},{name:"Australia",score:"0"}],           h1Home:0, h1Away:0 },
  "cuw-civ": { home_team:"Curacao",        away_team:"Ivory Coast",       completed:true, scores:[{name:"Curacao",score:"0"},{name:"Ivory Coast",score:"2"}],          h1Home:0, h1Away:1 },
  "ecu-ger": { home_team:"Ecuador",        away_team:"Germany",           completed:true, scores:[{name:"Ecuador",score:"2"},{name:"Germany",score:"1"}],              h1Home:0, h1Away:1 },
  "tun-ned": { home_team:"Tunisia",        away_team:"Netherlands",       completed:true, scores:[{name:"Tunisia",score:"1"},{name:"Netherlands",score:"3"}],          h1Home:0, h1Away:2 },
  "jpn-swe": { home_team:"Japan",          away_team:"Sweden",            completed:true, scores:[{name:"Japan",score:"1"},{name:"Sweden",score:"1"}],                 h1Home:1, h1Away:1 },
  // 6/26 MD3 games (Groups G, H, I)
  "nor-fra": { home_team:"Norway",         away_team:"France",            completed:true, scores:[{name:"Norway",score:"1"},{name:"France",score:"4"}],                 h1Home:0, h1Away:2 },
  "sen-irq": { home_team:"Senegal",        away_team:"Iraq",              completed:true, scores:[{name:"Senegal",score:"5"},{name:"Iraq",score:"0"}],                  h1Home:2, h1Away:0 },
  "uru-esp": { home_team:"Uruguay",        away_team:"Spain",             completed:true, scores:[{name:"Uruguay",score:"0"},{name:"Spain",score:"1"}],                 h1Home:0, h1Away:0 },
  "cpv-ksa": { home_team:"Cape Verde",     away_team:"Saudi Arabia",      completed:true, scores:[{name:"Cape Verde",score:"0"},{name:"Saudi Arabia",score:"0"}],       h1Home:0, h1Away:0 },
  "egy-iri": { home_team:"Egypt",          away_team:"Iran",              completed:true, scores:[{name:"Egypt",score:"1"},{name:"Iran",score:"1"}],                    h1Home:0, h1Away:1 },
  "nzl-bel": { home_team:"New Zealand",    away_team:"Belgium",           completed:true, scores:[{name:"New Zealand",score:"1"},{name:"Belgium",score:"5"}],           h1Home:0, h1Away:2 },
  // 6/27 MD3 games (Groups J, K, L)
  "cro-gha": { home_team:"Croatia",        away_team:"Ghana",             completed:true, scores:[{name:"Croatia",score:"2"},{name:"Ghana",score:"1"}],                 h1Home:1, h1Away:0 },
  "pan-eng": { home_team:"Panama",         away_team:"England",           completed:true, scores:[{name:"Panama",score:"0"},{name:"England",score:"2"}],                h1Home:0, h1Away:1 },
  "col-por": { home_team:"Colombia",       away_team:"Portugal",          completed:true, scores:[{name:"Colombia",score:"0"},{name:"Portugal",score:"0"}],             h1Home:0, h1Away:0 },
  "cod-uzb": { home_team:"DR Congo",       away_team:"Uzbekistan",        completed:true, scores:[{name:"DR Congo",score:"3"},{name:"Uzbekistan",score:"1"}],           h1Home:1, h1Away:0 },
  "alg-aut": { home_team:"Algeria",        away_team:"Austria",           completed:true, scores:[{name:"Algeria",score:"3"},{name:"Austria",score:"3"}],               h1Home:2, h1Away:1 },
  "jor-arg": { home_team:"Jordan",         away_team:"Argentina",         completed:true, scores:[{name:"Jordan",score:"1"},{name:"Argentina",score:"3"}],              h1Home:0, h1Away:2 },
  // 6/28 R32
  "rsa-can": { home_team:"South Africa",   away_team:"Canada",            completed:true, scores:[{name:"South Africa",score:"0"},{name:"Canada",score:"1"}],            h1Home:0, h1Away:0 },
};

// Normalize names coming FROM the Odds API
function normName(n) {
  return n.replace("Congo DR", "DR Congo").replace("Curaçao", "Curacao");
}

// Normalize team names stored IN bets to match Odds API names
function normBetTeam(n) {
  return (n || "")
    .replace("Czechia", "Czech Republic")
    .replace("Bosnia-Herzegovina", "Bosnia & Herzegovina")
    .replace("Oakland Athletics", "Athletics")
    .replace("Curaçao", "Curacao");
}

function resolveBet(bet, game, cornersTotal = null) {
  const homeScore = parseInt((game.scores.find(s => s.name === game.home_team) || {}).score || "0");
  const awayScore = parseInt((game.scores.find(s => s.name !== game.home_team) || {}).score || "0");
  const h1Home = game.h1Home ?? null;
  const h1Away = game.h1Away ?? null;

  // Use bet's stored homeTeam for market-text matching (avoids API name vs display name mismatch)
  const betHomeLC = (bet.homeTeam || game.home_team).toLowerCase();

  let result = "loss";
  const market = bet.market.toLowerCase();

  if (market.includes("corners")) {
    if (cornersTotal === null) result = "pending_corners"; // sentinel — caller will keep as pending
    else {
      const line = parseFloat(bet.market.match(/[\d.]+/)?.[0] || "0");
      if (market.includes("over"))       result = cornersTotal > line ? "win" : cornersTotal === line ? "push" : "loss";
      else if (market.includes("under")) result = cornersTotal < line ? "win" : cornersTotal === line ? "push" : "loss";
    }
  } else if (market.includes("1h over") || market.includes("1h under")) {
    const line = parseFloat(bet.market.match(/[\d.]+/)?.[0] || "0");
    const h1Total = h1Home != null ? h1Home + h1Away : homeScore + awayScore;
    if (market.includes("1h over"))  result = h1Total > line ? "win" : h1Total === line ? "push" : "loss";
    else                              result = h1Total < line ? "win" : h1Total === line ? "push" : "loss";
  } else if (market.includes("ht win") || market.includes("halftime")) {
    const h1H = h1Home ?? homeScore;
    const h1A = h1Away ?? awayScore;
    const pickedHome = market.includes(betHomeLC);
    if      (pickedHome  && h1H > h1A) result = "win";
    else if (!pickedHome && h1A > h1H) result = "win";
    else if (h1H === h1A)              result = "push";
  } else if (market.includes("1h") && market.includes("spread")) {
    const h1H = h1Home ?? homeScore;
    const h1A = h1Away ?? awayScore;
    const pickedHome = market.includes(betHomeLC);
    if      (pickedHome  && h1H > h1A) result = "win";
    else if (!pickedHome && h1A > h1H) result = "win";
    else if (h1H === h1A)              result = "push";
  } else if (market.includes("nrfi")) {
    result = (homeScore === 0 && awayScore === 0) ? "win" : "loss";
  } else if (market.includes("yrfi")) {
    result = (homeScore > 0 || awayScore > 0) ? "win" : "loss";
  } else if (market.includes("-1.5") || market.includes("run line")) {
    const pickedHome = market.includes(betHomeLC);
    if      (pickedHome  && (homeScore - awayScore) >= 2) result = "win";
    else if (!pickedHome && (awayScore - homeScore) >= 2) result = "win";
  } else if (market.includes("ml") || market.includes(" win") || market.includes("moneyline")) {
    const pickedHome = market.includes(betHomeLC);
    if      (pickedHome  && homeScore > awayScore) result = "win";
    else if (!pickedHome && awayScore > homeScore) result = "win";
    // Soccer draws are a loss for team-win bets; MLB ties are a push
    else if (homeScore === awayScore) result = bet.sport === "MLB" ? "push" : "loss";
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
      const pickedHome = market.includes(betHomeLC);
      const margin = homeScore - awayScore;
      const adj = pickedHome ? margin + point : -margin + (-point);
      if      (adj > 0) result = "win";
      else if (adj === 0) result = "push";
    }
  }

  // Compute a market-relevant resolved display value
  let resolvedValue = homeScore + "-" + awayScore;
  if (market.includes("corners") && cornersTotal !== null) {
    resolvedValue = cornersTotal + " corners";
  } else if ((market.includes("over") || market.includes("under")) && !market.includes("corners")) {
    resolvedValue = (homeScore + awayScore) + " total · " + homeScore + "-" + awayScore;
  }

  return { ...bet, result, resolvedAt: new Date().toISOString(), finalScore: homeScore + "-" + awayScore, resolvedValue };
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

  // Fetch ESPN corners data for WC games that have pending corners bets
  // cornersMap: "HomeTeam|AwayTeam" -> total corners (int)
  const cornersMap = {};
  const hasWCCornersBets = pending.some(b => b.sport === "WC" && b.market.toLowerCase().includes("corners"));
  if (hasWCCornersBets) {
    try {
      const sbRes = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard");
      if (sbRes.ok) {
        const sbData = await sbRes.json();
        const finishedEvents = (sbData.events || []).filter(e => {
          const status = (e.competitions?.[0]?.status?.type?.name || "");
          return status.includes("FULL_TIME") || status.includes("FINAL");
        });
        // Fetch summaries in parallel for finished games only
        await Promise.all(finishedEvents.map(async e => {
          try {
            const sumRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${e.id}`);
            if (!sumRes.ok) return;
            const sum = await sumRes.json();
            const teams = sum.boxscore?.teams || [];
            let totalCorners = 0;
            const teamNames = [];
            teams.forEach(t => {
              teamNames.push(t.team?.displayName || "");
              const c = (t.statistics || []).find(s => s.name === "wonCorners");
              if (c) totalCorners += parseInt(c.displayValue || c.value || 0);
            });
            if (teamNames.length === 2) {
              const key1 = teamNames[0] + "|" + teamNames[1];
              const key2 = teamNames[1] + "|" + teamNames[0];
              cornersMap[key1] = totalCorners;
              cornersMap[key2] = totalCorners;
            }
          } catch(_) {}
        }));
      }
    } catch(_) {}
  }

  // Resolve
  const resolved = bets.map(bet => {
    if (bet.result !== "pending") return bet;

    const normHome = normBetTeam(bet.homeTeam);
    const normAway = normBetTeam(bet.awayTeam);
    const matchedById = !!(scoreMap[bet.gameId]);
    let game = scoreMap[bet.gameId]
      || scoreMap[normHome + "|" + normAway]
      || scoreMap[normAway + "|" + normHome]
      || FALLBACK_GAMES[bet.gameId];

    if (!game?.completed) return bet;

    // Date guard: skip only for name-based matches (IDs are unique, no false-match risk).
    // Allow ±1 day to handle games starting late evening (UTC date tips to next day).
    if (!matchedById && bet.gameDate && game.commence_time) {
      const gameDate = new Date(game.commence_time).toISOString().slice(0, 10);
      const diffMs = Math.abs(new Date(gameDate) - new Date(bet.gameDate));
      if (diffMs > 2 * 24 * 60 * 60 * 1000) return bet;
    }

    // Attach corners total from ESPN for WC corners bets
    const cornersKey = (bet.homeTeam || "") + "|" + (bet.awayTeam || "");
    const cornersTotal = cornersMap[cornersKey] ?? cornersMap[bet.awayTeam + "|" + bet.homeTeam] ?? null;

    const resolved = resolveBet(bet, game, cornersTotal);
    return resolved.result === "pending_corners" ? bet : resolved;
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
