/**
 * The Melete extension's service worker.
 *
 * Off until the person switches it on in the popup. While on, it keeps a
 * native messaging connection to the companion's browser bridge on this
 * computer and carries out the browser requests the bridge hands it, only in
 * tabs it opened itself. Those tabs sit in a group named "Melete", each shows
 * a bar saying Melete is using it with a Stop button, and the toolbar icon
 * shows ON. Stop, from the bar or the popup, switches it off at once.
 *
 * It has no permission to read cookies and never sends them anywhere; pages
 * stay signed in because they are the person's own browser.
 */
import { clickRef, readPage, showBar, typeRef } from './page.js';

const HOST = 'com.melete.device';
const LOAD_TIMEOUT_MS = 30_000;

let port = null;
let state = 'off';
let device = null;
let retry = null;

const storage = chrome.storage.local;
const session = chrome.storage.session;

async function isOn() {
  return (await storage.get('on')).on === true;
}

async function meleteTabs() {
  return new Set((await session.get('tabs')).tabs ?? []);
}

async function remember(tabId) {
  const tabs = await meleteTabs();
  tabs.add(tabId);
  await session.set({ tabs: [...tabs] });
}

async function forget(tabId) {
  const tabs = await meleteTabs();
  tabs.delete(tabId);
  await session.set({ tabs: [...tabs] });
}

function setState(next, detail) {
  state = next;
  if (detail) device = detail;
  const on = next === 'connected';
  chrome.action.setBadgeText({ text: on ? 'ON' : next === 'off' ? '' : '…' });
  chrome.action.setBadgeBackgroundColor({ color: on ? '#1f7a4d' : '#8a8a8a' });
  chrome.runtime.sendMessage({ type: 'state', state, device }).catch(() => {});
}

function connect() {
  if (port) return;
  clearTimeout(retry);
  port = chrome.runtime.connectNative(HOST);
  setState('connecting');
  port.onMessage.addListener((message) => {
    if (message?.type === 'status') {
      setState(message.state, message.device ?? device);
      if (['off', 'revoked', 'unpaired'].includes(message.state)) void switchOff(false);
    }
    if (message?.type === 'request') void carryOut(message);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    if (state === 'off') return;
    setState('reconnecting');
    // The companion may not be running yet; try again while switched on.
    retry = setTimeout(async () => {
      if (await isOn()) connect();
    }, 5_000);
  });
}

async function switchOff(tellBridge = true) {
  await storage.set({ on: false });
  clearTimeout(retry);
  if (port) {
    if (tellBridge) port.postMessage({ type: 'stop' });
    const closing = port;
    port = null;
    setState('off');
    closing.disconnect();
  } else setState('off');
  for (const tabId of await meleteTabs()) {
    await chrome.scripting
      .executeScript({ target: { tabId }, func: showBar, args: [false] })
      .catch(() => {});
  }
}

function answer(id, result) {
  port?.postMessage({ type: 'answer', id, answer: { ok: true, result } });
}
function refuse(id, code, message) {
  port?.postMessage({ type: 'answer', id, answer: { ok: false, error: { code, message } } });
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === 'complete') done();
    };
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') done();
    }, done);
  });
}

async function describe(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { tab_id: tabId, url: tab.url ?? '', title: tab.title ?? '' };
}

async function inPage(tabId, func, args) {
  const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return frame?.result;
}

async function carryOut(request) {
  const { id, tool } = request;
  const args = request.arguments ?? {};
  try {
    if (!(await isOn()))
      return refuse(id, 'capability_off', 'The Melete extension is switched off.');
    if (tool === 'browser_open') {
      const url = new URL(String(args.url));
      if (!['http:', 'https:'].includes(url.protocol))
        return refuse(id, 'invalid_request', 'Only http and https pages are opened.');
      const tab = await chrome.tabs.create({ url: url.toString(), active: true });
      await remember(tab.id);
      try {
        const group = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(group, { title: 'Melete', color: 'blue' });
      } catch {
        // Grouping is a courtesy; the bar on the page is the indicator.
      }
      await waitForLoad(tab.id);
      await inPage(tab.id, showBar, [true]).catch(() => {});
      return answer(id, await describe(tab.id));
    }
    const tabId = Number(args.tab_id);
    if (!(await meleteTabs()).has(tabId))
      return refuse(id, 'unknown_tab', 'That tab was not opened for Melete, so it is not touched.');
    await chrome.tabs.get(tabId).catch(() => {
      throw new Error('That tab was closed.');
    });
    if (tool === 'browser_read') {
      await inPage(tabId, showBar, [true]).catch(() => {});
      const page = await inPage(tabId, readPage, [131_072, 200]);
      return answer(id, { ...(await describe(tabId)), ...page });
    }
    if (tool === 'browser_click' || tool === 'browser_type') {
      const outcome =
        tool === 'browser_click'
          ? await inPage(tabId, clickRef, [String(args.ref)])
          : await inPage(tabId, typeRef, [
              String(args.ref),
              String(args.text ?? ''),
              args.submit === true,
            ]);
      if (!outcome?.ok)
        return refuse(id, outcome?.code ?? 'failed', outcome?.message ?? 'It did not work.');
      // A click or Enter may start a navigation; let it land before reporting where the tab is.
      await new Promise((resolve) => setTimeout(resolve, 800));
      await waitForLoad(tabId);
      await inPage(tabId, showBar, [true]).catch(() => {});
      return answer(id, await describe(tabId));
    }
    if (tool === 'browser_screenshot') {
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return answer(id, { png_base64: image.slice(image.indexOf(',') + 1) });
    }
    return refuse(id, 'invalid_request', `Unknown request: ${tool}`);
  } catch (error) {
    return refuse(id, 'failed', error instanceof Error ? error.message : 'It did not work.');
  }
}

chrome.tabs.onRemoved.addListener((tabId) => void forget(tabId));

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'switch') {
    void (async () => {
      if (message.on) {
        await storage.set({ on: true });
        connect();
      } else await switchOff();
      reply({ state, device });
    })();
    return true;
  }
  if (message?.type === 'stop') {
    void switchOff().then(() => reply({ state }));
    return true;
  }
  if (message?.type === 'get') {
    reply({ state, device });
    return false;
  }
  return false;
});

// A browser restart keeps the person's choice.
chrome.runtime.onStartup.addListener(async () => {
  if (await isOn()) connect();
});
void isOn().then((on) => (on ? connect() : setState('off')));
