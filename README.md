# Quick Byt — Windows-native project (no Docker / no Ubuntu)

This project has 57 menu items (including 19 restored entries inferred from the existing image-override keys) and uses Node.js 22.16+ and the built-in `node:sqlite` module. It has no npm dependencies. Run locally on Windows using `START_QUICKBYT.bat` and open `http://localhost:5500`.

## Publish online

Follow [DEPLOY_ONLINE.md](DEPLOY_ONLINE.md). The recommended beginner setup is a single Render Web Service, because this app serves the frontend and API from the same Node process. It does not need a separate Vercel frontend deployment.

**Database warning:** the included Render Blueprint uses the Free service plan for demos. SQLite on Render's ephemeral filesystem will not reliably retain orders across restarts/spin-downs/redeploys. For actual order persistence, use a paid Render service with a disk mounted at `/var/data` and set `QUICKBYT_DB_PATH=/var/data/quickbyt.db`, or migrate to managed PostgreSQL.

## Local setup

1. Install Node.js 22.16+ from https://nodejs.org/.
2. Extract the ZIP and open the project root in VS Code.
3. Create `.env` at the project root with `QUICKBYT_MANAGER_PIN=your-private-pin` (6–64 characters).
4. Double-click `START_QUICKBYT.bat`.
5. Open `http://localhost:5500`.

Run checks with `npm run check`. The server health endpoint reports `menuCount` so you can tell if Render deployed the updated menu.

**Price review:** the 19 restored menu items use provisional example prices because those dishes had image overrides in the source but no actual rows/prices in the GitHub menu list. Review `MENU_ITEMS_RESTORED.md` and confirm prices before accepting real orders.

**Troubleshooting:** the local `.env` is never uploaded to GitHub and does not set the hosted PIN. In Render → your Quick Byt Web Service → Environment, set `QUICKBYT_MANAGER_PIN` to the PIN you actually want to type, save it, and redeploy/restart. The correct public URL is the Render *Web Service* URL; a static-only deployment will not run `/api` endpoints.
