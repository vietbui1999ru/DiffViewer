import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_HINT = 'Run CodeBoarding and write .codeboarding/analysis.json, or set DIFFVIEWER_ARCH_PATH.';

function field(obj, names) {
  for (const name of names) {
    if (obj && obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return undefined;
}

function escapeMermaidLabel(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, ' ');
}

function nodeId(raw, used) {
  const base = String(raw ?? 'component')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^([0-9])/, '_$1') || 'component';
  let id = base;
  let i = 2;
  while (used.has(id)) id = `${base}_${i++}`;
  used.add(id);
  return id;
}

function componentId(component) {
  return field(component, ['component_id', 'id', 'componentId', 'cluster_id', 'clusterId']);
}

function componentLabel(component, id) {
  return field(component, ['name', 'component_name', 'title', 'label']) ?? id;
}

function relationEnds(relation) {
  return {
    src: field(relation, ['src_id', 'source_id', 'source', 'from', 'source_component_id']),
    dst: field(relation, ['dst_id', 'target_id', 'target', 'to', 'target_component_id']),
  };
}

function metadataValue(analysis, names) {
  return field(analysis.metadata ?? {}, names) ?? field(analysis, names);
}

export function analysisToMermaid(analysis) {
  const components = Array.isArray(analysis?.components) ? analysis.components : [];
  const relations = Array.isArray(analysis?.components_relations)
    ? analysis.components_relations
    : Array.isArray(analysis?.relations)
      ? analysis.relations
      : [];

  const usedNodeIds = new Set();
  const ids = new Map();
  const lines = ['graph LR'];
  let expandableCount = 0;

  for (const component of components) {
    const rawId = componentId(component);
    if (!rawId) continue;
    const mermaidId = nodeId(rawId, usedNodeIds);
    ids.set(String(rawId), mermaidId);
    if (component.can_expand === true || Array.isArray(component.components)) expandableCount += 1;
    lines.push(`  ${mermaidId}["${escapeMermaidLabel(componentLabel(component, rawId))}"]`);
  }

  let relationCount = 0;
  for (const relation of relations) {
    const { src, dst } = relationEnds(relation);
    const srcNode = ids.get(String(src));
    const dstNode = ids.get(String(dst));
    if (!srcNode || !dstNode) continue;
    const label = field(relation, ['label', 'type', 'description']);
    lines.push(label
      ? `  ${srcNode} -- "${escapeMermaidLabel(label)}" --> ${dstNode}`
      : `  ${srcNode} --> ${dstNode}`);
    relationCount += 1;
  }

  return {
    mermaid: lines.join('\n'),
    meta: {
      repoName: metadataValue(analysis, ['repoName', 'repo_name', 'repository', 'project_name']) ?? null,
      generatedAt: metadataValue(analysis, ['generatedAt', 'generated_at', 'created_at']) ?? null,
      commitHash: metadataValue(analysis, ['commitHash', 'commit_hash', 'snapshotCommit']) ?? null,
      componentCount: ids.size,
      relationCount,
      expandableCount,
    },
  };
}

export function resolveArchitecturePath(repoRoot = process.cwd(), env = process.env) {
  const configured = env.DIFFVIEWER_ARCH_PATH;
  if (!configured) return path.join(repoRoot, '.codeboarding', 'analysis.json');
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

export async function readArchitectureArtifact(repoRoot = process.cwd(), env = process.env) {
  const filePath = resolveArchitecturePath(repoRoot, env);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { state: 'empty', path: filePath, hint: DEFAULT_HINT };
    }
    return { state: 'invalid', path: filePath, error: `Unable to read analysis.json: ${err.message}` };
  }

  try {
    return { state: 'ready', path: filePath, analysis: JSON.parse(raw) };
  } catch (err) {
    return { state: 'invalid', path: filePath, error: `Invalid analysis.json: ${err.message}` };
  }
}

export async function loadArchitectureView(repoRoot = process.cwd(), env = process.env) {
  const artifact = await readArchitectureArtifact(repoRoot, env);
  if (artifact.state === 'empty') {
    return { mermaid: null, state: 'empty', hint: artifact.hint, path: artifact.path };
  }
  if (artifact.state === 'invalid') {
    return { error: artifact.error, path: artifact.path };
  }
  return { ...analysisToMermaid(artifact.analysis), path: artifact.path };
}
