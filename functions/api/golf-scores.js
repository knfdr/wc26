// Proxies ESPN's public golf leaderboard API to avoid CORS issues.
// Returns normalized player scores for the current/most recent golf event.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const eventId = url.searchParams.get("event"); // optional ESPN event ID override

  const espnUrl = eventId
    ? `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${eventId}`
    : `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard`;

  try {
    const resp = await fetch(espnUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: "ESPN fetch failed", status: resp.status }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const raw = await resp.json();
    const events = raw.events || [];
    if (!events.length) {
      return new Response(JSON.stringify({ error: "No events found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Use first event (most current)
    const event = events[0];
    const competition = (event.competitions || [])[0];
    if (!competition) {
      return new Response(JSON.stringify({ error: "No competition data" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const statusType = competition.status?.type?.name || "";
    const currentRound = competition.status?.period || 1;
    const eventStatus = statusType.includes("FINAL") ? "final"
      : statusType.includes("IN_PROGRESS") ? "in_progress"
      : statusType.includes("SCHEDULED") ? "scheduled"
      : statusType;

    const players = {};
    for (const comp of (competition.competitors || [])) {
      const name = comp.athlete?.displayName || "";
      if (!name) continue;

      const linescores = comp.linescores || [];
      const r = [null, null, null, null];
      linescores.forEach(ls => {
        const period = (ls.period || ls.displayPeriod || 0) - 1;
        const val = parseInt(ls.value || ls.displayValue, 10);
        if (period >= 0 && period < 4 && !isNaN(val)) r[period] = val;
      });

      // Determine how many rounds are fully complete.
      // A round is complete if the player's score for that round is non-null
      // AND it's a past round (not the current in-progress one, unless event is final).
      const roundsComplete = eventStatus === "final"
        ? r.filter(v => v !== null).length
        : Math.max(0, (r.filter(v => v !== null).length) - (statusType.includes("IN_PROGRESS") ? 1 : 0));

      const statusName = comp.status?.type?.name || comp.status?.type?.id || "";
      const made_cut = !statusName.toLowerCase().includes("cut");
      const withdrew = statusName.toLowerCase().includes("wd") || statusName.toLowerCase().includes("disqualified");

      const toParStat = (comp.statistics || []).find(s => s.name === "toPar" || s.name === "score");
      const toParStr = comp.status?.displayValue || toParStat?.displayValue || "";
      const toPar = toParStr === "E" ? 0 : parseInt(toParStr, 10) || null;

      const position = comp.status?.position?.displayValue || comp.status?.displayValue || "";

      // teeTime is used to reconstruct playing groups
      const teeTime = comp.teeTime || comp.athlete?.teeTime || null;

      players[name] = { r1: r[0], r2: r[1], r3: r[2], r4: r[3], toPar, position, made_cut, withdrew, roundsComplete, teeTime };
    }

    // Build playing groups: bucket competitors by teeTime, keep groups of 2-4
    const groups = [];
    const byTeeTime = {};
    for (const [name, d] of Object.entries(players)) {
      if (!d.teeTime) continue;
      // Normalize teeTime to minute precision to group together
      const key = d.teeTime.slice(0, 16); // "2026-06-18T08:00"
      if (!byTeeTime[key]) byTeeTime[key] = [];
      byTeeTime[key].push(name);
    }
    for (const [, grp] of Object.entries(byTeeTime).sort(([a],[b]) => a.localeCompare(b))) {
      if (grp.length >= 2) groups.push(grp);
    }

    const result = {
      eventId: event.id,
      eventName: event.name || event.shortName || "",
      currentRound,
      eventStatus,
      fetchedAt: Date.now(),
      players,
      groups, // array of string[] — each inner array is one playing group
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=120", // 2-min edge cache
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
