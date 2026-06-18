export async function onRequest(context) {
  const url = new URL(context.request.url);
  const sport = url.searchParams.get("sport");
  const markets = url.searchParams.get("markets") || "h2h,totals";
  const bookmakers = url.searchParams.get("bookmakers");
  if (!sport) return new Response("Missing sport", { status: 400 });

  let apiUrl = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${context.env.ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american`;
  if (bookmakers) apiUrl += `&bookmakers=${bookmakers}`;
  const resp = await fetch(apiUrl);
  const data = await resp.text();
  return new Response(data, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}
