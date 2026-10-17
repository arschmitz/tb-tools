const functionWords = new Set(('the and but for with without from into onto over under between through ' +
  'are was were been being does did can could should would will may might must ' +
  'not its this that these those each every all any some you they their our your ' +
  'how what where when which who why').split(' '));
const tokens = text => text.match(/[\p{L}\p{N}_-]{3,}/gu) || [];

// Keep quoted words, paths and dotted names. A query made only of function words stays searchable.
export function retrievalTerms(query) {
  const text = String(query);
  const words = [...new Set(tokens(text))].slice(0, 80);
  const protectedWords = new Set();
  for (const match of text.matchAll(/['"`]([^'"`\n]+)['"`]|[\p{L}\p{N}_-]+(?:[./\\][\p{L}\p{N}_-]+)+/gu)) {
    for (const word of tokens(match[1] || match[0])) protectedWords.add(word);
  }
  const questionStart = /^(?:where|when|how|why|what|which|who|are|was|were|does|did|can|could|should|would|will|may|might|must)\b/i.test(text.trim());
  const occurrences = tokens(text);
  const salient = words.filter(word => {
    const lower = word.toLowerCase();
    const startsQuestion = questionStart && word === words[0] && occurrences.filter(value => value === word).length === 1;
    return (word !== lower && !startsQuestion) || protectedWords.has(word) || !functionWords.has(lower);
  });
  return { words: salient.length ? salient : words, omitted: salient.length ? words.filter(word => !salient.includes(word)) : [] };
}
