# Sharp Sim sign-in setup (Cloudflare Access + per-person Kalshi keys)

Do steps 1–5 **before** merging this branch to `main`. The new code fails closed: if the
Access settings are missing it shows "Sign-in isn't set up" instead of letting anyone in.

## 1. Turn on Zero Trust (free, up to 50 people)
1. dash.cloudflare.com → **Zero Trust** in the left sidebar.
2. First time: pick a **team name** (for example `sharpsim`) → choose the **Free** plan. Cloudflare may ask for a card; Free is $0.
3. Zero Trust → **Settings → Authentication → Login methods**: **One-time PIN** is on by default (an emailed code). Optionally **Add new → Google** so people can sign in with Google instead.

## 2. Put Access in front of the site
1. Zero Trust → **Access → Applications → Add an application → Self-hosted**.
2. Name: `Sharp Sim`. Session duration: `1 month` (or what you like).
3. **Add public hostname**: domain `wc26-94e.pages.dev`. Add a second one: `*.wc26-94e.pages.dev` (covers preview deploys).
4. **Policies → Add a policy**: name `Invited`, action **Allow**, Include → **Emails** → your email and each friend's email. Save the application.
5. Open the application → **Overview / Basic information** → copy the **Application Audience (AUD) Tag**.

## 3. Create the storage for people's keys and settings
1. dash.cloudflare.com → **Storage & Databases → KV → Create** → name `sharp-sim-users`.
2. **Workers & Pages → wc26 (the Pages project) → Settings → Bindings → Add → KV namespace**:
   variable name `USERS`, namespace `sharp-sim-users`. (Production; add to Preview too if you use previews.)

## 4. Variables (Workers & Pages → wc26 → Settings → Variables and secrets, Production)
| Name | Type | Value |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | Text | `<team name>.cloudflareaccess.com` |
| `ACCESS_AUD` | Text | the AUD tag from step 2.5 |
| `OWNER_EMAIL` | Text | your email (the one you sign in with) |
| `FRIEND_EMAILS` | Text | friends' emails, comma-separated |
| `USER_KEYS_SECRET` | **Secret** | a long random string (in Terminal: `openssl rand -base64 32`). Encrypts everyone's saved Kalshi keys; if you change it, saved keys stop working and people re-enter them. |

Your existing `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY`, `KALSHI_MAX_ORDER_DOLLARS` stay as they are: they are now used **only when you are signed in**.

Adding a friend later = add their email to the Access policy (step 2.4) **and** to `FRIEND_EMAILS`.

## 5. Merge and check
1. Merge the `claude/site-auth-e2c376` branch to `main` (that deploys).
2. Open https://wc26-94e.pages.dev → Cloudflare asks for your email → enter the code → the site loads with a badge bottom-right: your email · OWNER · Account · Sign out.
3. Then delete the old `SITE_PASSWORD` variable.

## Who can do what
- **Everyone invited**: every page, pick, grade and price; their own bet-size settings; the shared win/loss record (read).
- **Anyone with their own Kalshi key** (added on `/account`): BET buttons place orders on *their* Kalshi account, capped by their own "max per bet". Keys are checked with Kalshi before saving, stored AES-GCM encrypted, and never shown again.
- **Owner only**: the auto trader (`/api/runner/*`, the live page's runner controls) and writes to the shared pick record. Your server key is never used for anyone else's request.
- **Site-wide kill switch**: `KALSHI_TRADING_ENABLED` must be `1` for *anyone's* order to be sent.
