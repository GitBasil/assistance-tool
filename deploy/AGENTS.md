# Agent: publishing Footsteps

When the user asks to **publish / deploy / ship** this project to production:

1. Read [`deploy/README.md`](./README.md) fully before acting.
2. Use the **admin** SSH kit at `../server-access` (`mechanic-shop` / `basilt`), not `troodak-deploy-handoff`.
3. Prefer `./deploy/publish.sh` for routine updates.
4. Never wipe `C:\apps\assistance-tool\data` and never commit private keys or `CREDENTIALS.md`.
5. Prove success with `https://ultrainnovate.com/ready` returning JSON `ok: true`.

Production host: **https://ultrainnovate.com** (dashboard at `/dashboard`, script at `/assist.js`).
