import config from "./config.mjs";
import { readJsonResponse } from "./http.mjs";
import {
  cacheBugzillaRevisions,
  findCachedReviewer,
  getCachedBugzillaRevisions,
  logBugzillaRevisionRequest,
} from "./phab.mjs";

const inflight = new Map();

export async function getBugzillaRevisions(bugId, { bypassCache = false } = {}) {
  const id = String(bugId);
  if (!/^\d+$/.test(id)) throw new Error("A numeric Bugzilla bug ID is required.");
  const cached = !bypassCache && await getCachedBugzillaRevisions(id);
  let revisions;
  if (cached) {
    logBugzillaRevisionRequest({ event: "cache-hit", params: { ids: [id] } });
    revisions = cached.revisions;
  } else {
    if (!inflight.has(id)) {
      const request = (async () => {
        const started = Date.now();
        logBugzillaRevisionRequest({ event: "request-start", params: { ids: [id] } });
        try {
          const response = await fetch(`https://bugzilla.mozilla.org/rest/phabbugz/bug_revisions/${id}`, {
            headers: { "X-BUGZILLA-API-KEY": config.bugzilla.apiKey },
            signal: AbortSignal.timeout(30000),
          });
          logBugzillaRevisionRequest({ event: "response", params: { ids: [id] }, statusCode: response.status, durationMs: Date.now() - started });
          const data = await readJsonResponse(response, "Bugzilla Phabricator revisions");
          if (!Array.isArray(data.revisions)) throw new Error("Bugzilla did not return a revision list.");
          await cacheBugzillaRevisions(id, data);
          return data.revisions;
        } catch (error) {
          logBugzillaRevisionRequest({ event: "request-error", params: { ids: [id] }, durationMs: Date.now() - started });
          throw error;
        }
      })();
      inflight.set(id, request);
      request.finally(() => inflight.delete(id)).catch(() => {});
    }
    revisions = await inflight.get(id);
  }
  return Promise.all(revisions.map(async (revision) => ({
    ...revision,
    reviews: await Promise.all((revision.reviews || []).map(async (review) => ({
      ...review,
      identity: await findCachedReviewer(review.user),
    }))),
  })));
}
