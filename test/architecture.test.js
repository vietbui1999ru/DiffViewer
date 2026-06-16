import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analysisToMermaid,
  loadArchitectureView,
  readArchitectureArtifact,
  resolveArchitecturePath,
} from '../src/architecture.js';
import fixture from './fixtures/architecture-minimal.json' with { type: 'json' };

describe('architecture artifact reader', () => {
  it('defaults to .codeboarding/analysis.json under repo root', () => {
    expect(resolveArchitecturePath('/repo', {})).toBe(path.join('/repo', '.codeboarding', 'analysis.json'));
  });

  it('supports DIFFVIEWER_ARCH_PATH override relative to repo root', () => {
    expect(resolveArchitecturePath('/repo', { DIFFVIEWER_ARCH_PATH: 'tmp/arch.json' }))
      .toBe(path.join('/repo', 'tmp/arch.json'));
  });

  it('returns empty state when analysis.json is absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffviewer-arch-'));
    const result = await readArchitectureArtifact(root, {});
    expect(result.state).toBe('empty');
    expect(result.hint).toMatch(/CodeBoarding/);
  });

  it('returns invalid state for malformed JSON', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffviewer-arch-'));
    await fs.mkdir(path.join(root, '.codeboarding'));
    await fs.writeFile(path.join(root, '.codeboarding', 'analysis.json'), '{nope');
    const result = await readArchitectureArtifact(root, {});
    expect(result.state).toBe('invalid');
    expect(result.error).toMatch(/Invalid analysis\.json/);
  });
});

describe('analysisToMermaid', () => {
  it('renders top-level components and directed relations', () => {
    const result = analysisToMermaid(fixture);
    expect(result.mermaid).toContain('graph LR');
    expect(result.mermaid).toContain('app_api["API Layer"]');
    expect(result.mermaid).toContain('app_core["Core Engine"]');
    expect(result.mermaid).toContain('app_api -- "calls" --> app_core');
    expect(result.meta).toMatchObject({
      repoName: 'demo-repo',
      commitHash: 'abc123',
      componentCount: 2,
      relationCount: 1,
      expandableCount: 1,
    });
  });

  it('ignores relations whose endpoints are not top-level components', () => {
    const result = analysisToMermaid({
      components: [{ component_id: 'a', name: 'A' }],
      components_relations: [{ src_id: 'a', dst_id: 'a.child' }],
    });
    expect(result.meta.relationCount).toBe(0);
    expect(result.mermaid).not.toContain('-->');
  });

  it('escapes label characters that would break Mermaid quotes', () => {
    const result = analysisToMermaid({
      components: [{ component_id: 'a', name: 'API "Gateway" & Proxy' }],
      components_relations: [],
    });

    expect(result.mermaid).toContain('API &quot;Gateway&quot; &amp; Proxy');
  });
});

describe('loadArchitectureView', () => {
  it('loads a valid artifact into endpoint payload shape', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diffviewer-arch-'));
    await fs.mkdir(path.join(root, '.codeboarding'));
    await fs.writeFile(path.join(root, '.codeboarding', 'analysis.json'), JSON.stringify(fixture));
    const result = await loadArchitectureView(root, {});
    expect(result.mermaid).toContain('graph LR');
    expect(result.meta.componentCount).toBe(2);
  });
});
