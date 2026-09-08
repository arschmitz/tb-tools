import path from "node:path";

export const WORKING_CHECKOUT = "working";
export const REVIEW_CHECKOUT = "review";

function getConfiguredPath(value) {
  const configured = String(value || "").trim();

  return configured ? path.resolve(configured) : "";
}

export function getReviewCheckoutConfig(config = {}) {
  const reviewCheckout = config?.reviewCheckout || {};
  const firefoxPath = getConfiguredPath(
    reviewCheckout.firefoxPath || reviewCheckout.firefox,
  );
  const commPath = getConfiguredPath(
    reviewCheckout.commPath || reviewCheckout.comm,
  );

  if (!firefoxPath || !commPath) {
    return null;
  }

  return { firefoxPath, commPath };
}

function getGraphLabel({ checkout, repository, includeReview }) {
  if (!includeReview && checkout === WORKING_CHECKOUT) {
    return repository;
  }

  return `${checkout === REVIEW_CHECKOUT ? "Review" : "Working"} ${repository}`;
}

function createCheckoutGraph({
  checkout,
  repository,
  cwd,
  includeReview,
}) {
  return {
    id: `${checkout}-${repository}`,
    checkout,
    repository,
    label: getGraphLabel({ checkout, repository, includeReview }),
    cwd,
  };
}

export function resolveGraphCheckouts({
  cwd = process.cwd(),
  config = {},
  comm = true,
  firefox = true,
  includeReview = false,
} = {}) {
  const workingCommPath = path.resolve(cwd);
  const workingFirefoxPath = path.resolve(workingCommPath, "..");
  const reviewCheckout = includeReview ? getReviewCheckoutConfig(config) : null;
  const hasReviewCheckout = Boolean(reviewCheckout);
  const checkouts = [];

  if (comm) {
    checkouts.push(createCheckoutGraph({
      checkout: WORKING_CHECKOUT,
      repository: "comm",
      cwd: workingCommPath,
      includeReview: hasReviewCheckout,
    }));
  }

  if (firefox) {
    checkouts.push(createCheckoutGraph({
      checkout: WORKING_CHECKOUT,
      repository: "firefox",
      cwd: workingFirefoxPath,
      includeReview: hasReviewCheckout,
    }));
  }

  if (reviewCheckout && comm) {
    checkouts.push(createCheckoutGraph({
      checkout: REVIEW_CHECKOUT,
      repository: "comm",
      cwd: reviewCheckout.commPath,
      includeReview: true,
    }));
  }

  if (reviewCheckout && firefox) {
    checkouts.push(createCheckoutGraph({
      checkout: REVIEW_CHECKOUT,
      repository: "firefox",
      cwd: reviewCheckout.firefoxPath,
      includeReview: true,
    }));
  }

  return checkouts;
}
