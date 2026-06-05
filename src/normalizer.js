import { createPatch } from 'diff';

function mapTool(toolName) {
  return String(toolName).toLowerCase() === 'write' ? 'write' : 'edit';
}

export function normalizeEvent({ tool, path, oldContent, newContent }) {
  const oldStr = oldContent ?? '';
  const newStr = newContent ?? '';
  return {
    tool: mapTool(tool),
    path,
    unifiedDiff: createPatch(path, oldStr, newStr),
    isNew: oldStr === '',
  };
}
