import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const PORT = Number(process.env.PORT ?? 3456);
const HOST = process.env.HOST ?? 'localhost';

// Passkeys are tied to this address, so it must match the URL people visit.
const origin = new URL(process.env.ORIGIN ?? `http://localhost:${PORT}`).origin;
const rpID = new URL(origin).hostname;
const rpName = 'Passkey Demo';

const MAX_ACCOUNTS = 1000;
const MAX_BODY_BYTES = 100_000;
const MAX_USERNAME_LENGTH = 64;
const CEREMONY_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;

// Everything lives in memory, so a restart wipes it. See "Limits" in the README.
const accounts = new Map(); // username -> { username, webauthnUserID, passkeys }
const sessions = new Map(); // session ID -> { ceremony, username, lastSeen }

const secureCookie = origin.startsWith('https:') ? '; Secure' : '';

// Mermaid writes inline styles into its diagrams, so style-src allows them.
const securityHeaders = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const staticFiles = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/simplewebauthn-browser.js': [
    'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js',
    'text/javascript; charset=utf-8',
  ],
  '/mermaid.js': ['node_modules/mermaid/dist/mermaid.min.js', 'text/javascript; charset=utf-8'],
};

const getSession = (req, res) => {
  const id = req.headers.cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  const existing = sessions.get(id);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }

  const newId = randomUUID();
  const session = { ceremony: null, username: null, lastSeen: Date.now() };
  sessions.set(newId, session);
  res.setHeader(
    'set-cookie',
    `sid=${newId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureCookie}`,
  );
  return session;
};

const startCeremony = (session, ceremony) => {
  session.ceremony = { ...ceremony, expiresAt: Date.now() + CEREMONY_TTL_MS };
};

// A challenge works once, so it is cleared whether or not verification succeeds.
const finishCeremony = (session, type) => {
  const { ceremony } = session;
  session.ceremony = null;
  if (ceremony?.type !== type || ceremony.expiresAt < Date.now()) {
    throw new Error(`No ${type} in progress`);
  }
  return ceremony;
};

const assertCanRegister = (username) => {
  if (accounts.has(username)) throw new Error('That username is taken');
  if (accounts.size >= MAX_ACCOUNTS) throw new Error('This demo is full. Try again after it restarts');
};

const findPasskey = (id) => {
  for (const account of accounts.values()) {
    const passkey = account.passkeys.find((p) => p.id === id);
    if (passkey) return { account, passkey };
  }
  return null;
};

const describeAccount = ({ username, webauthnUserID, passkeys }) => ({
  username,
  password: null,
  webauthnUserID,
  passkeys: passkeys.map((passkey) => ({
    ...passkey,
    publicKey: Buffer.from(passkey.publicKey).toString('base64url'),
  })),
});

const routes = {
  'GET /api/state': async (_body, session) => {
    const account = accounts.get(session.username);
    return account ? describeAccount(account) : null;
  },

  'POST /api/register/options': async ({ username }, session) => {
    const name = String(username ?? '').trim();
    if (!name) throw new Error('Enter a username first');
    if (name.length > MAX_USERNAME_LENGTH) {
      throw new Error(`Usernames can be up to ${MAX_USERNAME_LENGTH} characters`);
    }
    assertCanRegister(name);

    // The verify functions refuse a response without user verification, so both ceremonies ask for it.
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    startCeremony(session, { type: 'registration', username: name, options });
    return options;
  },

  'POST /api/register/verify': async (body, session) => {
    const { username, options } = finishCeremony(session, 'registration');

    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: options.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    if (!verified) throw new Error('The passkey could not be verified');
    assertCanRegister(username);

    const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
    accounts.set(username, {
      username,
      webauthnUserID: options.user.id,
      passkeys: [
        {
          id: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        },
      ],
    });
    session.username = username;
    return { verified, username };
  },

  'POST /api/login/options': async (_body, session) => {
    // Empty allowCredentials lets the passkey itself say who is signing in, so no username is typed.
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: [],
    });
    startCeremony(session, { type: 'sign-in', challenge: options.challenge });
    return options;
  },

  'POST /api/login/verify': async (body, session) => {
    const { challenge } = finishCeremony(session, 'sign-in');

    const found = findPasskey(body.id);
    if (!found) throw new Error('This passkey is not registered on the server');

    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: found.passkey,
    });
    if (!verified) throw new Error('The sign-in could not be verified');

    found.passkey.counter = authenticationInfo.newCounter;
    session.username = found.account.username;
    return { verified, username: found.account.username };
  },
};

const readJSON = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new Error('This request is too large');
  }
  return raw ? JSON.parse(raw) : {};
};

const handleRequest = async (req, res) => {
  for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);

  const { pathname } = new URL(req.url, origin);

  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  const file = req.method === 'GET' && staticFiles[pathname];
  if (file) {
    const [path, type] = file;
    const contents = await readFile(new URL(path, import.meta.url));
    res.writeHead(200, { 'content-type': type });
    return res.end(contents);
  }

  const route = routes[`${req.method} ${pathname}`];
  if (!route) {
    res.writeHead(404);
    return res.end();
  }

  try {
    const result = await route(await readJSON(req), getSession(req, res));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
};

createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(PORT, HOST, () => {
  console.log(`Passkey demo running at ${origin}`);
  if (!process.env.ORIGIN && HOST !== 'localhost') {
    console.warn('ORIGIN is not set, so passkeys will only work on localhost');
  }
});

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) sessions.delete(id);
  }
}, SESSION_TTL_MS).unref();
