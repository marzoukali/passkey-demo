# Passkey Demo

A small web app that shows how passkey sign-in works, built with [SimpleWebAuthn](https://simplewebauthn.dev/).

You can create an account, sign in without a password, try to replay an old sign-in and see exactly what the server stores. The **Explained** tab covers the demo, FIDO, passkeys, hardware binding and digital wallets in plain English. The **Flows** tab draws the journey from creating an account to signing in, once at a high level and once with the API calls, and marks where a long-running server is needed.

This is a learning demo, not a base for a production app. See [Limits](#limits).

## Run it locally

You need Node.js 22.12 or later.

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3456.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3456` | The port the server listens on. |
| `HOST` | `localhost` | The address the server listens on. Use `0.0.0.0` on a hosting platform. |
| `ORIGIN` | `http://localhost:<PORT>` | The public address of the site, such as `https://passkeys.example.com`. Passkeys are tied to this hostname. |

## Why it needs a long-running server

Creating an account or signing in takes two separate requests: one to get a challenge and one to send back the signed answer. The server has to remember the challenge between those requests, and it has to remember the public key until the next sign-in. This demo keeps all of that in the memory of one running Node.js process.

| Held in memory | Kept for | If it is lost | In a real app |
| --- | --- | --- | --- |
| Challenge | 5 minutes, or until it is used | The step in progress fails, and you start it again | A shared store such as Redis, with a 5-minute expiry |
| Session | About an hour | The page stops showing your account, but your passkey still works | A shared store such as Redis, or a signed cookie |
| Account and public key | Until the server restarts | The account is gone, and your passkey can no longer sign in | A database such as PostgreSQL |

Serverless hosting doesn't suit this. It can start a fresh copy of the program for each request, so the second request may reach a copy that never saw the first one and has no challenge to check against. Running several instances behind a load balancer has the same problem.

This comes from how the demo is built, not from passkeys. Passkeys only need storage that lasts between requests. With all three moved out of the process, the server keeps nothing between requests, so it could run on serverless hosting or across many instances. Read and delete each challenge in one action, so it can only be used once. The **Flows** tab marks where each of these is needed.

## Deploy it

Any host that can run a long-running Node.js process will work, as long as it meets these rules:

- The site must use HTTPS. Browsers allow passkeys over plain HTTP only on `localhost`.
- `ORIGIN` must exactly match the address people visit.
- Run a single instance, because accounts and sessions are held in that process's memory.

### Render

1. Push this repository to GitHub, GitLab or Bitbucket.
2. In the [Render Dashboard](https://dashboard.render.com), choose **New > Web Service** and select the repository.
3. Set **Language** to Node, **Build Command** to `npm ci --omit=dev` and **Start Command** to `npm start`.
4. Choose an instance type, then add the environment variable `HOST` with the value `0.0.0.0`.
5. Create the service and copy its `onrender.com` address from the top of the page.
6. Add the environment variable `ORIGIN` with that address, such as `https://your-service.onrender.com`, then save and deploy.

Render's Free instance type sleeps after 15 minutes without traffic, and accounts are wiped when it does. Everyone would then need to create a new passkey, so use a paid instance if the demo needs to stay up during a session.

## Limits

- Accounts are held in memory and are lost on every restart or deploy.
- A deployed copy is public. Anyone with the address can create an account, and there is no rate limiting. The demo stops accepting new accounts at 1,000.
- There is no account recovery, sign-out or protected content. Signing in only proves that the passkey flow works.
- Creating a passkey and signing in both require user verification, so a security key needs a PIN or fingerprint set up first.

## Test passkeys

Creating an account saves a real passkey in your password manager or on your security key. It stays there after the server forgets the account, and it won't work on any other address. You can delete it from your password manager when you finish.

## Project layout

| File | Purpose |
| --- | --- |
| `server.js` | Web server, passkey checks and in-memory storage |
| `public/index.html` | The **Try it**, **Explained** and **Flows** tabs, including the Mermaid source of the diagrams |
| `public/app.js` | Browser side of the passkey flow, the tab controls and diagram drawing |
| `public/styles.css` | Page styles, including dark mode |
