// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderArchitecture, renderTurnCard, updateTabTitle } from '../browser/app.js';

const snap = {
  sessionId: 's1',
  turnNumber: 3,
  events: [
    { tool: 'write', path: 'a.js', unifiedDiff: 'Index: a.js\n@@ -0,0 +1 @@\n+hi\n', isNew: true },
    { tool: 'edit', path: 'b.js', unifiedDiff: 'Index: b.js\n@@ -1 +1 @@\n-x\n+y\n', isNew: false },
  ],
};

beforeEach(() => { document.body.innerHTML = ''; document.title = ''; });

describe('renderTurnCard', () => {
  it('AC-UI1 builds a card with one diff card per event', () => {
    const card = renderTurnCard(snap, document);
    expect(card.querySelectorAll('[data-testid="file-card"]')).toHaveLength(2);
    expect(card.textContent).toContain('s1');
  });

  it('AC-UI2 distinguishes write vs edit badge', () => {
    const card = renderTurnCard(snap, document);
    const badges = [...card.querySelectorAll('[data-testid="tool-badge"]')].map(b => b.textContent.toLowerCase());
    expect(badges).toContain('write');
    expect(badges).toContain('edit');
  });

  it('AC-UI3 marks new files', () => {
    const card = renderTurnCard(snap, document);
    const newCard = card.querySelector('[data-testid="file-card"]');
    expect(newCard.querySelector('[data-testid="new-file"]')).not.toBeNull();
  });

  it('AC-UI4 diff bodies start collapsed; header toggles', () => {
    const card = renderTurnCard(snap, document);
    const fc = card.querySelector('[data-testid="file-card"]');
    const body = fc.querySelector('[data-testid="diff-body"]');
    expect(body.hidden).toBe(true);
    fc.querySelector('[data-testid="file-header"]').click();
    expect(body.hidden).toBe(false);
  });

  it('AC-UI6 updateTabTitle reflects count', () => {
    updateTabTitle(2);
    expect(document.title).toBe('(2) Diff Viewer');
  });
});

describe('renderArchitecture', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <p id="architecture-meta"></p>
      <div id="architecture-output"></div>
    `;
  });

  it('renders a mermaid diagram and metadata', () => {
    renderArchitecture({
      mermaid: 'graph LR\n  a["A"]',
      meta: { repoName: 'demo', componentCount: 1, relationCount: 0 },
    }, document, null);

    expect(document.getElementById('architecture-meta').textContent).toContain('demo');
    expect(document.querySelector('[data-testid="architecture-diagram"]').textContent).toContain('graph LR');
  });

  it('renders empty and error states inline', () => {
    renderArchitecture({ state: 'empty', hint: 'run CodeBoarding' }, document, null);
    expect(document.getElementById('architecture-output').textContent).toContain('run CodeBoarding');

    renderArchitecture({ error: 'bad analysis' }, document, null);
    expect(document.getElementById('architecture-output').textContent).toContain('bad analysis');
  });
});
