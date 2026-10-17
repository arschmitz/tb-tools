// Deliberate user-directed guidance. Source counts do not establish policy.
export const CODE_STYLE_GUIDANCE = `When writing, reviewing, or verifying Thunderbird code:
Choose style for the exact language, folder, file role, and section. Read the
implementation, relevant callers, current per-file lint and formatter settings,
inline exceptions, and nearby accepted code in the same component and harness.
Separate required configuration, accepted local practice, and suggested defaults.
Tests, shared test head files, fixtures, generated code, imported code,
privileged modules, content scripts, workers, and Storybook can have different
rules. A test exception does not authorize the same operation in production code.
One file can contain sections with different contracts. Check the actual receiver
and caller; a method name alone does not identify a built-in API. Do not infer a
global rule from counts, one example, an old patch, or a provisional review summary.

For new JavaScript that visits iterable values and performs actions, prefer
for...of to Array.prototype.forEach when behavior stays the same and the affected
section has no stronger reason for another form. Use an indexed for loop when
the index, reverse order, stride, or index-controlled mutation is the contract.
Use while for a condition-controlled loop. Keep map/filter for returned arrays,
some/every for a Boolean result, and find for a matching value. Use reduce when
the accumulated result stays clear; do not hide several actions in a callback.
Iterate an iterator directly when no array operation or stable snapshot is needed.
Do not mechanically replace forEach. Check sparse arrays, mutation, initial length,
callback arguments, this binding, custom APIs, and callback return behavior.
Calendar cal.iterate.forEach yields to the event queue and has its own completion
and BREAK/CONTINUE contract. It is not Array.prototype.forEach.
Use for...of with await for ordered async work. Use Promise.all only when the
operations may overlap and its rejection and cleanup behavior fits the caller.
Array.prototype.forEach does not wait for promises returned by its callback.
Do not turn a sequential test scenario into parallel work as a style change.
Use for...in only when enumerating property names, including inherited names
when intended. Object.keys/entries and for...of have different contracts.

Use const when the binding is not reassigned; const does not freeze its value.
Use let for reassigned bindings. Check shared script globals before replacing var.
Keep names concrete and follow the local file, symbol, DOM, CSS, and Fluent family.
Preserve public and stored names. Use destructuring when it makes roles clearer;
do not lose a method's receiver or hide confusing defaults in a long pattern.
Keep guards, branches, and state updates easy to follow. Follow current lint for
object shorthand, nested ternaries, unnecessary else branches, and switch cases.
Do not replace equality, truth checks, or defaults without checking types and valid
0, false, empty-string, null, and undefined values. Follow local equality practice;
there is no blanket === mandate in this guidance. ?? and || mean different things.
Use optional chaining when absence is allowed, not to hide a required object.
Choose methods, functions, and arrows with this binding and callback identity in
mind. Preserve listener removal, required signatures, and the caller's result.
Follow the environment's static or lazy import rules. Handle async completion,
rejection, cancellation, and cleanup explicitly when the caller needs them.

Keep useful blank-line groups and local method organization. Separate distinct
logical steps with a blank line when it makes the flow easier to follow. Follow
nearby accepted code and keep closely related statements together. In tests,
make setup, actions, and expected results easy to distinguish. During writing,
review, and verification, inspect this grouping separately from formatter and
lint results. A formatter pass does not establish readable grouping. Do not
impose fixed blank-line counts or add a blank line after every statement.

In tests, follow the actual harness and section: named tasks, assertion APIs,
shared helpers, fixtures, setup, cleanup, and browser preference handling.
When writing tests, do not add try/finally blocks. Use the test harness setup
and cleanup hooks. Register cleanup before setup can fail.
This is writing guidance, not a patch-review criterion.
Use SpecialPowers.pushPrefEnv where the browser-test rules require it. Check
Calendar test rules for UTC dates. Check resolved rules when overrides overlap.
Wait for an event or state condition instead of an arbitrary delay. Keep test
steps and failures easy to locate. Use scalar assertions for scalar results and
deep assertions for structures when supported by the harness. Apply the existing
assertion-message rule: every message written or self-reviewed must contain
"should" and state the expected behavior. Do not report a missing "should" alone
as a defect in someone else's patch. Do not rewrite intentional invalid fixtures.

For CSS, markup, localization, C++, Rust, Python, IDL, and build files, use their
own configuration and accepted component patterns. Do not export JavaScript rules
to another language. Check logical CSS properties, shared tokens, selector scope,
semantic markup, labels, and stable localization IDs in their actual consumers.
Preserve ownership, error handling, platform contracts, and generated-file rules.
Let the applicable formatter choose mechanical layout; nested settings can differ.
Do not rewrite unrelated code or report a harmless alternative as a defect.
For a style finding, state its scope, source or rule, concrete change, and reason.
Read the code-style guide and coverage limits in the shared CONSUMING.md when
more detail is needed. Automatic learning must not edit this deliberate guidance.
`;
