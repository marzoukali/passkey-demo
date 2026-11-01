const {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} = SimpleWebAuthnBrowser;

const $ = (id) => document.getElementById(id);
let lastLogin = null;

const log = (text) => {
  const item = document.createElement('li');
  item.textContent = text;
  $('log').append(item);
};

const showStatus = (id, text, kind) => {
  $(id).textContent = text;
  $(id).className = `status ${kind}`;
};

const post = async (path, body = {}) => {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};

const refreshState = async () => {
  const account = await (await fetch('/api/state')).json();
  $('state').textContent = account ? JSON.stringify(account, null, 2) : 'Nothing yet';
};

const diagrams = [...document.querySelectorAll('.diagram')].map((figure) => ({ figure, source: figure.textContent }));
const darkMode = matchMedia('(prefers-color-scheme: dark)');
let diagramsRequested = false;
let mermaidLoaded;

// Mermaid is a large file, so it loads only when someone opens the Flows tab.
const loadMermaid = () => {
  mermaidLoaded ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/mermaid.js';
    script.addEventListener('load', resolve);
    script.addEventListener('error', reject);
    document.head.append(script);
  });
  return mermaidLoaded;
};

const diagramTheme = () => {
  const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return {
    darkMode: darkMode.matches,
    background: color('--panel'),
    fontFamily: 'system-ui, sans-serif',
    fontSize: '13px',
    primaryColor: color('--code'),
    primaryTextColor: color('--text'),
    primaryBorderColor: color('--muted'),
    secondaryColor: color('--panel'),
    tertiaryColor: color('--bg'),
    lineColor: color('--muted'),
    textColor: color('--text'),
    clusterBkg: color('--bg'),
    clusterBorder: color('--line'),
    edgeLabelBackground: color('--panel'),
    actorBkg: color('--code'),
    actorBorder: color('--muted'),
    actorTextColor: color('--text'),
    actorLineColor: color('--line'),
    signalColor: color('--text'),
    signalTextColor: color('--text'),
    noteBkgColor: color('--accent'),
    noteTextColor: color('--accent-text'),
    noteBorderColor: color('--accent'),
    sequenceNumberColor: color('--accent-text'),
  };
};

const drawDiagrams = async () => {
  try {
    await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: diagramTheme(),
      fontFamily: 'system-ui, sans-serif',
      fontSize: 13,
      flowchart: { useMaxWidth: false, wrappingWidth: 280 },
      sequence: { useMaxWidth: false, actorMargin: 20, width: 130, diagramMarginX: 10 },
    });
    for (const [index, { figure, source }] of diagrams.entries()) {
      const { svg } = await mermaid.render(`diagram-${index}`, source);
      figure.innerHTML = svg;
    }
    $('flows-status').textContent = '';
  } catch (error) {
    console.error(error);
    $('flows-status').textContent = 'The diagrams could not be drawn, so their source is shown instead.';
    for (const source of document.querySelectorAll('.diagram pre')) source.hidden = false;
  }
};

darkMode.addEventListener('change', () => {
  if (diagramsRequested) drawDiagrams();
});

const tabs = [...document.querySelectorAll('[role="tab"]')];

const selectTab = (selected) => {
  for (const tab of tabs) {
    const isSelected = tab === selected;
    tab.setAttribute('aria-selected', isSelected);
    tab.tabIndex = isSelected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !isSelected;
  }
  if (selected.id === 'tab-flows' && !diagramsRequested) {
    diagramsRequested = true;
    drawDiagrams();
  }
};

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
  });
}

$('register').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const optionsJSON = await post('/api/register/options', { username: $('username').value });
    log(`Server created a challenge for "${optionsJSON.user.name}"`);
    const response = await startRegistration({ optionsJSON });
    log('Your device made a key pair and signed the challenge');
    const { username } = await post('/api/register/verify', response);
    log(`Server verified it and saved the public key for "${username}"`);
    showStatus('register-status', 'Passkey created. Now sign in.', 'good');
    await refreshState();
  } catch (error) {
    log(`Registration stopped: ${error.message}`);
    showStatus('register-status', error.message, 'bad');
  }
});

$('login').addEventListener('click', async () => {
  try {
    const optionsJSON = await post('/api/login/options');
    log('Server created a new one-time challenge');
    lastLogin = await startAuthentication({ optionsJSON });
    log('Your device signed the challenge with the private key');
    const { username } = await post('/api/login/verify', lastLogin);
    log(`Server checked the signature against the public key: this is "${username}"`);
    showStatus('login-status', `Signed in as ${username}`, 'good');
    $('replay').disabled = false;
    await refreshState();
  } catch (error) {
    log(`Sign-in stopped: ${error.message}`);
    showStatus('login-status', 'Not signed in', 'bad');
  }
});

$('replay').addEventListener('click', async () => {
  try {
    await post('/api/login/options');
    log('Attacker opened a new sign-in, which gets a new challenge');
    await post('/api/login/verify', lastLogin);
    log('Replay was accepted');
    showStatus('replay-status', 'Replay accepted', 'bad');
  } catch (error) {
    log(`Server refused the replay: ${error.message}`);
    showStatus('replay-status', 'Refused: the signature was for an old challenge', 'good');
  }
});

const checkSupport = async () => {
  if (!browserSupportsWebAuthn()) {
    $('support').textContent = 'This browser does not support passkeys. Try a recent version of Chrome, Edge, Safari or Firefox.';
  } else if (!(await platformAuthenticatorIsAvailable())) {
    $('support').textContent = 'No built-in authenticator found here. You can still use a phone or security key.';
  }
};

refreshState();
checkSupport();
