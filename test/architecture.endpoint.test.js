import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import fixture from './fixtures/architecture-minimal.json' with { type: 'json' };

async function repoWithArtifact(contents) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffviewer-arch-endpoint-'));
  await fs.mkdir(path.join(root, '.codeboarding'));
  await fs.writeFile(path.join(root, '.codeboarding', 'analysis.json'), contents);
  return root;
}

describe('GET /api/architecture', () => {
  it('returns mermaid and meta for a valid analysis artifact', async () => {
    const root = await repoWithArtifact(JSON.stringify(fixture));
    const app = createApp({ architectureRoot: root, env: {} });
    const res = await app.request('/api/architecture');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mermaid).toContain('app_api');
    expect(body.meta.componentCount).toBe(2);
  });

  it('returns empty state when artifact is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffviewer-arch-endpoint-'));
    const app = createApp({ architectureRoot: root, env: {} });
    const res = await app.request('/api/architecture');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('empty');
    expect(body.mermaid).toBeNull();
  });

  it('returns 400 when artifact is malformed', async () => {
    const root = await repoWithArtifact('{bad');
    const app = createApp({ architectureRoot: root, env: {} });
    const res = await app.request('/api/architecture');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid analysis\.json/);
  });
});
