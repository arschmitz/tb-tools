// Deliberate writing guidance. Source observations remain separate evidence.
export const COMMENT_WRITING_GUIDANCE = `When writing or reviewing source comments or JSDoc:
Read the implementation and relevant callers first. Add a comment when it explains
a reason, constraint, caller contract, or non-obvious action. Follow the affected
repository's comment coverage rules. Do not add narration for obvious code.
Add short clarifying comments beside complex or non-obvious logic. Explain the
reason, constraint, ordering, or effect that the reader cannot readily infer.
During reviews, suggest the missing explanation within the review scope. Do not
invent intent.
Use short, natural sentences with common words. Name the actor and target. For a
function summary, use a concrete present-tense verb: "Returns...", "Sets...", or
"Removes...". The function is the implied subject. For instructions, use "Use..."
or "Do not...". Put a condition first when it controls the action: "If X, do Y."
Then state the result or reason when the reader needs it. Keep cause and effect
in order. Avoid long chains of clauses, vague noun groups, and canned value claims.
Use complete sentences for explanations. Short labels and type descriptions can
be fragments. Use articles naturally: "Sets the input value", not "Sets value of
input". Repeat a name when "it", "this", "they", or "its" could refer to two things.
Prefer active voice. Keep passive voice when the result matters and the actor is
unknown or unimportant. Use present tense for current behavior. Use "must" for a
real requirement and "can" for a capability; do not turn a suggestion into a rule.
Keep exact identifiers, conditions, exceptions, links, and necessary details.
Explain a technical term when the intended reader may not know it. Preserve the
local human voice; do not add invented purpose, generic praise, or rigid templates.
When explaining safety, name the value and how long it remains valid. If a check
is skipped, name the condition that makes the check unnecessary. For a workaround,
name the result that would change without it.
For test setup, name the state the test recreates and any simulated action.
For JSDoc, keep the summary, parameters, types, returns, defaults, errors, and
side effects accurate. State what an async promise resolves to and what completion
means when callers need it. Use small checked examples when usage is unclear.
Check: useful comment; true behavior; clear actor and target; clear condition,
reason, and result; unambiguous references; accurate caller contract; local format.
Every assertion must have a non-empty message that states the expected behavior.
Apply this rule when writing assertions, including examples and local experiments,
and during every review, self-review, verification, and repair flow. Check the
actual assertion API and message argument, including assertions in shared helpers.
Report missing or empty messages in assertions within the review scope, including
other authors' patches. Do not treat a nearby comment or test name as the message.
Keep unrelated assertions outside the requested change unchanged.

When writing or self-reviewing tests, every assertion message must contain the
word "should" and state the expected behavior. For example: "The Save button
should be disabled." Check this before finishing a test change. When reviewing
someone else's patch, prefer this form, but do not report a missing "should" alone
as a defect. Still report messages that describe the wrong expected behavior.
Later source studies or guidance can refine this rule through a deliberate
instruction update. Until then, apply the current rule.
These are user-directed writing rules and practical suggestions, not a claim
that every existing comment is correct. Do not rewrite unrelated comments.
`;
