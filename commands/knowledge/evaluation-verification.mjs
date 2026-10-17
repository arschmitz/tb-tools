import { execFileSync } from 'node:child_process';
import { parseKnowledgeNote } from './repository.mjs';

// Verify source identity. This does not prove that a required fact follows from a source.
export function verifySuiteAnchors(suite, roots) {
  const checked = [], errors = [];
  const anchors = suite.cases.flatMap(item => [
    ...item.anchors.map(anchor => ({ caseId: item.id, ...anchor })),
    ...item.evidence.flatMap(group => (group.anchors || []).map(anchor => ({ caseId: item.id, ...anchor }))),
  ]);
  for (const anchor of anchors) {
    try {
      const cwd = roots[anchor.repository];
      if (!cwd) throw new Error(`No checkout supplied for ${anchor.repository}.`);
      const text = execFileSync('git', ['show', `${anchor.revision}:${anchor.path}`], { cwd, encoding: 'utf8', maxBuffer: 8_000_000 });
      if (anchor.blob) {
        const blob = execFileSync('git', ['rev-parse', `${anchor.revision}:${anchor.path}`], { cwd, encoding: 'utf8' }).trim();
        if (blob !== anchor.blob) throw new Error('Source blob differs.');
      }
      if (anchor.id && parseKnowledgeNote(text).id !== anchor.id) throw new Error('Pinned note record ID differs.');
      if ((anchor.contains || []).some(value => !text.includes(value))) throw new Error('Checked source excerpt is absent.');
      checked.push(anchor);
    } catch (error) { errors.push({ ...anchor, error: error.message }); }
  }
  return { status: errors.length ? 'failed' : 'verified', checked, errors,
    limit: 'Source identity and retained excerpts verified. Required facts and exceptions still require code reading and semantic review.' };
}
