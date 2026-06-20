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

function renderAnnotationBox(ev, snapshot, doc) {
  const textarea = el(doc, 'textarea', {
    className: 'annotation-input',
    placeholder: 'Annotate this file…',
  });
  textarea.dataset.testid = 'annotation-input';

  const btn = el(doc, 'button', { textContent: 'Note', className: 'annotation-send' });
  btn.dataset.testid = 'annotation-send';

  const hasTask = typeof snapshot.task === 'string' && snapshot.task;
  if (!hasTask) {
    btn.disabled = true;
    btn.title = 'No task active — annotation requires a bus task';
  }

  btn.addEventListener('click', async () => {
    if (!hasTask) return;
    const body = textarea.value.trim();
    if (!body) return;
    try {
      const res = await fetch('/annotate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          task: snapshot.task,
          turn: snapshot.turnNumber,
          anchor: `card:${ev.path}`,
          bodyText: body,
          author: 'human',
        }),
      });
      if (res.ok) {
        textarea.value = '';
        btn.textContent = 'Noted';
        setTimeout(() => { btn.textContent = 'Note'; }, 1500);
      } else {
        btn.textContent = 'Error';
        setTimeout(() => { btn.textContent = 'Note'; }, 2000);
      }
    } catch {
      btn.textContent = 'Disconnected';
      setTimeout(() => { btn.textContent = 'Note'; }, 2000);
    }
  });

  return el(doc, 'div', { className: 'annotation' }, [textarea, btn]);
}

function renderFileCard(ev, snapshot, doc) {
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

  const annotation = renderAnnotationBox(ev, snapshot, doc);
  annotation.hidden = true;

  header.addEventListener('click', () => {
    body.hidden = !body.hidden;
    annotation.hidden = body.hidden;
  });

  const card = el(doc, 'div', { className: 'file-card' }, [header, body, annotation]);
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
    const text = steerBox.value.trim();
    if (!text) return;
    try {
      const res = await fetch('/steer', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: snapshot.rawSessionId ?? snapshot.sessionId,
          text,
          synthetic: snapshot.synthetic === true,
        }),
      });
      if (res.ok) {
        steerBox.value = '';
      } else {
        sendBtn.textContent = 'Error';
        setTimeout(() => { sendBtn.textContent = 'Send'; }, 2000);
      }
    } catch {
      sendBtn.textContent = 'Disconnected';
      setTimeout(() => { sendBtn.textContent = 'Send'; }, 2000);
    }
  });
  const steer = el(doc, 'div', { className: 'steer' }, [steerBox, sendBtn]);

  const card = el(doc, 'section', { className: 'turn-card' }, [title]);
  card.dataset.testid = 'turn-card';
  card.dataset.session = snapshot.sessionId;
  for (const ev of snapshot.events) card.append(renderFileCard(ev, snapshot, doc));
  card.append(steer);
  return card;
}

export function renderArchitecture(data, doc = document, mermaid = globalThis.window?.mermaid) {
  const output = doc.getElementById('architecture-output');
  const meta = doc.getElementById('architecture-meta');
  if (!output || !meta) return;

  output.replaceChildren();
  meta.textContent = '';

  if (data.error) {
    output.append(el(doc, 'p', { className: 'architecture-error', textContent: data.error }));
    return;
  }

  if (data.state === 'empty') {
    output.append(el(doc, 'p', { className: 'architecture-empty', textContent: data.hint }));
    return;
  }

  const details = data.meta ?? {};
  meta.textContent = [
    details.repoName,
    details.componentCount !== undefined ? `${details.componentCount} components` : null,
    details.relationCount !== undefined ? `${details.relationCount} relations` : null,
  ].filter(Boolean).join(' · ');

  const diagram = el(doc, 'div', { className: 'mermaid', textContent: data.mermaid ?? '' });
  diagram.dataset.testid = 'architecture-diagram';
  output.append(diagram);
  if (mermaid?.run) mermaid.run({ nodes: [diagram] });
}

async function loadArchitecture() {
  const output = document.getElementById('architecture-output');
  if (output) output.textContent = 'Loading architecture...';
  try {
    const res = await fetch('/api/architecture');
    const data = await res.json();
    renderArchitecture(data);
  } catch (err) {
    renderArchitecture({ error: `Unable to load architecture: ${err.message}` });
  }
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('.tab[data-view]')];
  const views = [document.getElementById('turns'), document.getElementById('architecture')].filter(Boolean);
  let architectureLoaded = false;
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const t of tabs) t.classList.toggle('is-active', t === tab);
      for (const view of views) view.hidden = view.id !== tab.dataset.view;
      if (tab.dataset.view === 'architecture' && !architectureLoaded) {
        architectureLoaded = true;
        loadArchitecture();
      }
    });
  }
  document.getElementById('architecture-refresh')?.addEventListener('click', loadArchitecture);
}

export function init() {
  const root = document.getElementById('turns');
  const status = document.getElementById('status');
  let count = 0;

  if (window.mermaid?.initialize) window.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
  setupTabs();

  const es = new EventSource('/stream');
  es.addEventListener('turn-complete', (e) => {
    let snapshot;
    try { snapshot = JSON.parse(e.data); } catch { return; }
    root.prepend(renderTurnCard(snapshot));
    updateTabTitle(++count);
  });
  es.addEventListener('open', () => { status.textContent = ''; status.hidden = true; });
  es.addEventListener('error', () => { status.textContent = 'disconnected — reconnecting…'; status.hidden = false; });
}

if (typeof window !== 'undefined' && document.getElementById('turns')) {
  init();
}
