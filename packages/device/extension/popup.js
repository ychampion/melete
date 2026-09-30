const WORDS = {
  off: 'Off',
  connecting: 'Connecting…',
  reconnecting: 'Waiting for the companion…',
  connected: 'On',
  revoked: 'Disconnected in Melete',
  unpaired: 'This computer is not paired',
};
const HINTS = {
  reconnecting: 'Start the companion on this computer: bun packages/device/src/cli.ts',
  unpaired: 'Pair this computer first: bun packages/device/src/cli.ts pair',
  revoked: 'Pair this computer again from Settings → Devices in Melete.',
};

const state = document.getElementById('state');
const toggle = document.getElementById('toggle');
const hint = document.getElementById('hint');
let current = 'off';

function show(next) {
  current = next.state ?? 'off';
  state.textContent = `${WORDS[current] ?? current}${next.device && current === 'connected' ? ` · ${next.device}` : ''}`;
  toggle.textContent = current === 'off' ? 'Switch on' : 'Stop';
  toggle.className = current === 'off' ? 'primary' : '';
  hint.textContent = HINTS[current] ?? '';
}

toggle.addEventListener('click', async () => {
  show(await chrome.runtime.sendMessage({ type: 'switch', on: current === 'off' }));
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state') show(message);
});
chrome.runtime.sendMessage({ type: 'get' }).then(show);
