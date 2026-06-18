function renderPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sharp Sim</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100vh;background:#070b14;font-family:'IBM Plex Mono','Courier New',monospace;color:#dde5f0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.wrap{width:100%;max-width:400px;padding:0 24px}
.badge{display:inline-block;background:rgba(232,197,71,0.1);border:1px solid rgba(232,197,71,0.25);color:#e8c547;font-size:9px;letter-spacing:3px;padding:3px 12px;border-radius:2px;margin-bottom:20px}
.title{font-size:36px;font-weight:700;letter-spacing:-1px;margin-bottom:6px;background:linear-gradient(135deg,#e8c547 0%,#dde5f0 60%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sub{font-size:10px;color:#4b6280;letter-spacing:1px;margin-bottom:36px}
.card{background:#101d30;border:1px solid #1a2a3e;border-radius:8px;padding:28px}
label{display:block;font-size:8px;color:#4b6280;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}
input{width:100%;background:#070b14;border:1px solid #1a2a3e;border-radius:4px;color:#dde5f0;font-family:'IBM Plex Mono','Courier New',monospace;font-size:14px;padding:10px 14px;outline:none;transition:border-color 0.15s}
input:focus{border-color:#e8c54766}
.error{font-size:10px;color:#ef4444;margin-top:10px;margin-bottom:0;letter-spacing:0.5px}
button{margin-top:16px;width:100%;background:#e8c547;color:#070b14;border:none;border-radius:4px;font-family:'IBM Plex Mono','Courier New',monospace;font-size:11px;font-weight:700;letter-spacing:2px;padding:11px;cursor:pointer;transition:opacity 0.15s}
button:hover{opacity:0.88}
.glow{position:fixed;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse at 50% 20%,rgba(232,197,71,0.05) 0%,transparent 60%);pointer-events:none}
</style>
</head>
<body>
<div class="glow"></div>
<div class="wrap">
  <div style="text-align:center;margin-bottom:32px">
    <div class="badge">⚡ SHARP SIM · SPORTS BETTING MODELS</div>
    <div class="title">Sharp Sim</div>
    <div class="sub">Monte Carlo · Dixon-Coles · Markov Chain</div>
  </div>
  <div class="card">
    <form method="POST" action="/login">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" placeholder="Enter password..." autofocus autocomplete="current-password">
      ${error ? '<p class="error">Incorrect password.</p>' : ''}
      <button type="submit">Enter →</button>
    </form>
  </div>
</div>
</body>
</html>`;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    const error = new URL(request.url).searchParams.has("error");
    return new Response(renderPage(error), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }

  if (request.method === "POST") {
    const body = await request.formData();
    const password = (body.get("password") || "").trim();

    if (password === env.SITE_PASSWORD) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `sharp-auth=${env.SITE_PASSWORD}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
        },
      });
    }

    return Response.redirect(new URL("/login?error=1", request.url).toString(), 302);
  }

  return new Response("Method not allowed", { status: 405 });
}
