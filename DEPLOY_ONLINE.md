# Put Quick Byt online (no Docker, no Ubuntu)

This project serves the frontend and API from the same Node.js web service, so the simplest deployment is one Render Web Service. You do not need Vercel for this version.

## 1. Push this folder to GitHub

Create an empty repository at https://github.com/new. From a terminal opened in this project folder, run:

```powershell
git init
git add .
git status
git commit -m "Prepare Quick Byt for deployment"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/quickbyt.git
git push -u origin main
```

Replace the repository URL with your actual GitHub repository. Before committing, make sure `.env` is NOT listed in `git status`; `.gitignore` should exclude it. Do not commit your real manager PIN or SQLite database.

## 2. Create the Render service

1. Sign in at https://render.com/ and connect GitHub.
2. Choose **New + → Blueprint** and select your Quick Byt repository. The `render.yaml` file configures a Node web service, runs the project checks, starts the app, and sets the runtime host.
3. If you prefer manual setup, choose **New + → Web Service**, select this repository, set Runtime to Node, Build Command to `npm run check`, and Start Command to `npm start`.
4. Set the environment variables in Render:
   - `NODE_VERSION` = `24.22.1`
   - `HOST` = `0.0.0.0`
   - `QUICKBYT_MANAGER_PIN` = your private 6–64 character PIN/passphrase
   - Do not set `PORT` yourself. Render supplies it.
5. Deploy and open the URL Render gives you. The same URL serves the website and `/api` endpoints.

The app now recognizes same-origin requests, so after the deployed URL is known you do not need to configure `QUICKBYT_ALLOWED_ORIGIN` for the normal single-domain setup. If you intentionally host the frontend on another domain, add its exact origin to that variable.

## 3. Test the live URL

If Render gives you `https://quickbyt-example.onrender.com`, test:

- `https://quickbyt-example.onrender.com/` — website
- `https://quickbyt-example.onrender.com/api/health` — API health
- `https://quickbyt-example.onrender.com/api/menu` — menu JSON

Then place a Cash test order and check the manager dashboard.

## Critical database warning

This Blueprint uses Render's **Free** service plan to make it easy to publish a demo. The app currently uses SQLite at `data/quickbyt.db`. Render Free web services have an ephemeral filesystem and spin down after inactivity; local database changes can be lost on restart, spin-down, or redeploy. Do NOT rely on this configuration for real canteen orders or payments.

For persistent SQLite on Render, use a paid web service with a persistent disk mounted at `/var/data`, then set `QUICKBYT_DB_PATH=/var/data/quickbyt.db`. Alternatively, migrate the app to a managed PostgreSQL database before treating it as a real ordering system.

## Other important notes

- `QUICKBYT_MANAGER_PIN` belongs in Render's Environment settings, not in `server.js`, `frontend/config.js`, or GitHub.
- `quickbyt@upi` is a placeholder. Replace it only with the canteen's confirmed merchant UPI ID.
- UPI status is not automatically verified: a UTR number alone is not proof of payment. The manager must verify the merchant account before marking payment as paid.
- A Render Free service can take about a minute to wake after being idle. That is normal for the free tier.


## Troubleshooting: backend not connected or manager PIN rejected

Open `https://YOUR-RENDER-SERVICE.onrender.com/api/health` using the actual service URL Render assigned to you. A healthy updated service returns JSON with `status: "ok"`, `menuCount: 57`, and `managerPinConfigured: true`.

- If `/api/health` doesn't return JSON, make sure you created a **Web Service/Blueprint**, not a Static Site, and that the service root is the repository root. The `server.js` file must run with `npm start`; use the URL from that Render Web Service.
- If health succeeds but `menuCount` is below 57, the backend is on old code. Push `server.js`, `frontend/index.html`, and `backend/menu_seed.json` to GitHub, then choose **Manual Deploy → Deploy latest commit** in Render.
- If the manager login says the PIN is wrong, the server is reachable. Check **Render → Quick Byt service → Environment → `QUICKBYT_MANAGER_PIN`**. The `.env` on your PC is ignored by Git and isn't uploaded to Render. Set the variable to the same value you type into Manager Portal, save it, and restart/redeploy the service. Enter it without spaces at the start/end. If you have made five wrong attempts, wait five minutes or redeploy before retrying.
- The health response never returns the PIN; `managerPinConfigured` is only a boolean.

## Restored menu entries

The updated site and seed include 57 dishes. Read `MENU_ITEMS_RESTORED.md` before using it for real orders: prices for the 19 restored items are provisional estimates because their actual prices weren't in the GitHub version checked for this fix. Confirm the canteen's rate list and edit both `frontend/index.html` and `backend/menu_seed.json` if any prices differ.
