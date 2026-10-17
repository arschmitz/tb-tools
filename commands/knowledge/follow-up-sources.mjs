export function createFollowUpSources() {
  let browser;
  return {
    async getReview(revision, { signal } = {}) {
      const { createPhabricatorWebSession } = await import("../graph/phab-auth.mjs");
      browser ||= createPhabricatorWebSession();
      return browser.getReview({ revision, signal, includeRawPatch: false });
    },
    async getBug(id, { signal } = {}) {
      const { getBugsByIds } = await import("../../lib/bugzilla.mjs");
      const bugs = await getBugsByIds([id], { permissive: false, signal,
        includeFields: "id,summary,status,resolution,product,component,last_change_time,regressed_by,regressions,see_also" });
      if (!bugs[0]) throw new Error(`Bug ${id} was not returned.`);
      return bugs[0];
    },
    async getBugComments(id, options) {
      const { getBugComments } = await import("../../lib/bugzilla.mjs");
      return getBugComments(id, options);
    },
  };
}
