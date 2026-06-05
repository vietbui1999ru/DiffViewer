// Pure-ish DOM builders are exported for unit tests; init() wires the live UI.
// diff2html is loaded globally from the CDN (window.Diff2Html) in the browser.

export function updateTabTitle(count) {
  document.title = `(${count}) Diff Viewer`;
}

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

function renderFileCard(ev, doc) {
  const badge = el(doc, 'span', { textContent: ev.tool, className: `badge badge-${ev.tool}` });
  badge.dataset.testid = 'tool-badge';

  const header = el(doc, 'button', { className: 'file-header', textContent: `${ev.path} ` });
  header.dataset.testid = 'file-header';
  header.prepend(badge);

  if (ev.isNew) {
    const tag = el(doc, 'span', { textContent: 'new file', className: 'new-file' });
    tag.dataset.testid = 'new-file';
    header.append(tag);
  }

  const body = el(doc, 'div', { className: 'diff-body', hidden: true });
  body.dataset.testid = 'diff-body';
  // diff2html is absent under jsdom; guard so unit tests run.
  if (typeof window !== 'undefined' && window.Diff2Html) {
    body.innerHTML = window.Diff2Html.html(ev.unifiedDiff, {
      inputFormat: 'diff', drawFileList: false, outputFormat: 'line-by-line',
    });
  } else {
    body.textContent = ev.unifiedDiff;
  }

  header.addEventListener('click', () => { body.hidden = !body.hidden; });

  const card = el(doc, 'div', { className: 'file-card' }, [header, body]);
  card.dataset.testid = 'file-card';
  return card;
}

export function renderTurnCard(snapshot, doc = document) {
  const title = el(doc, 'div', {
    className: 'turn-title',
    textContent: `session ${snapshot.sessionId} · turn ${snapshot.turnNumber}`,
  });

  const steerBox = el(doc, 'textarea', { className: 'steer-input', placeholder: 'Steer this session…' });
  const sendBtn = el(doc, 'button', { textContent: 'Send', className: 'steer-send' });
  sendBtn.dataset.testid = 'steer-send';
  sendBtn.addEventListener('click', async () => {
    const text = steerBox.value;
    const res = await fetch('/steer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: snapshot.sessionId, text }),
    });
    if (res.ok) steerBox.value = '';
  });
  const steer = el(doc, 'div', { className: 'steer' }, [steerBox, sendBtn]);

  const card = el(doc, 'section', { className: 'turn-card' }, [title]);
  card.dataset.testid = 'turn-card';
  card.dataset.session = snapshot.sessionId;
  for (const ev of snapshot.events) card.append(renderFileCard(ev, doc));
  card.append(steer);
  return card;
}

export function init() {
  const root = document.getElementById('turns');
  const status = document.getElementById('status');
  let count = 0;

  const es = new EventSource('/stream');
  es.addEventListener('turn-complete', (e) => {
    const snapshot = JSON.parse(e.data);
    root.prepend(renderTurnCard(snapshot));
    updateTabTitle(++count);
  });
  es.addEventListener('open', () => { status.textContent = ''; status.hidden = true; });
  es.addEventListener('error', () => { status.textContent = 'disconnected — reconnecting…'; status.hidden = false; });
}

if (typeof window !== 'undefined' && document.getElementById('turns')) {
  init();
}
