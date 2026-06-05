import { describe, it, expect } from 'vitest';
import { normalizeEvent } from '../src/normalizer.js';

describe('normalizeEvent', () => {
  it('AC-N1 existing file: isNew false, diff has a hunk', () => {
    const e = normalizeEvent({ tool: 'Edit', path: 'a.js', oldContent: 'old\n', newContent: 'new\n' });
    expect(e.isNew).toBe(false);
    expect(e.path).toBe('a.js');
    expect(e.unifiedDiff).toContain('@@');
    expect(e.unifiedDiff).toContain('-old');
    expect(e.unifiedDiff).toContain('+new');
  });

  it('AC-N2 new file: isNew true, diff is all-green', () => {
    const e = normalizeEvent({ tool: 'Write', path: 'b.js', oldContent: '', newContent: 'hello\n' });
    expect(e.isNew).toBe(true);
    expect(e.unifiedDiff).toContain('+hello');
    expect(e.unifiedDiff).not.toMatch(/^-[^-]/m);
  });

  it('AC-N3 tool mapping: Write->write, Edit/MultiEdit->edit', () => {
    expect(normalizeEvent({ tool: 'Write', path: 'a', oldContent: '', newContent: 'x' }).tool).toBe('write');
    expect(normalizeEvent({ tool: 'Edit', path: 'a', oldContent: 'x', newContent: 'y' }).tool).toBe('edit');
    expect(normalizeEvent({ tool: 'MultiEdit', path: 'a', oldContent: 'x', newContent: 'y' }).tool).toBe('edit');
  });

  it('AC-N4 diff header carries the filename', () => {
    const e = normalizeEvent({ tool: 'Write', path: 'src/foo.ts', oldContent: '', newContent: 'a\n' });
    expect(e.unifiedDiff).toContain('src/foo.ts');
  });
});
