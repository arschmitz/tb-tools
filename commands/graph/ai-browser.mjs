import { chromium } from "playwright";

export function launchReviewBrowser() {
  return chromium.launch({ headless: true });
}
