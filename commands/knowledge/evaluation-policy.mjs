// Keep benchmark questions, answer keys, and result payloads out of learned evidence.
export function isEvaluationData(record) {
  const paths = [...(record.paths || []), record.source?.file || ''].filter(value => typeof value === 'string');
  const copiedFixture = typeof record.text === 'string' && record.text.includes('Expected answers are evaluation data, never evidence.') && /"cases\\*"\s*:/.test(record.text);
  return record.source?.type === 'knowledge-evaluation' || copiedFixture || paths.some(value =>
    value.replaceAll('\\', '/').includes('test/fixtures/knowledge-evaluation/') ||
    /(?:^|\/)test\/fixtures\/knowledge-evaluation$/.test(value.replaceAll('\\', '/')) ||
    /(?:^|\/)knowledge-evaluation\/.*\.(?:json|jsonl)$/.test(value.replaceAll('\\', '/')));
}
