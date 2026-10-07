import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import openUrl from "open";
import defaultConfig from "../lib/config.mjs";
import { run } from "../lib/utils.mjs";
import {
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_CONSOLE_PORT,
  GRAPH_CLIENT_SCRIPTS,
  GRAPH_CLIENT_STYLESHEETS,
} from "./graph/constants.mjs";
import { getCheckoutGraphData, getCheckoutGraphMetadata } from "./graph/data.mjs";
import { resolveGraphCheckouts } from "./graph/checkouts.mjs";
import { getGraphOutputPath, writeGraphClientAssets } from "./graph/assets.mjs";
import { startInteractiveGraphServer, waitForInteractiveServerClose } from "./graph/server.mjs";
import {
  buildGraphHtml,
  buildInteractiveGraphLauncherHtml,
} from "./graph/templates.mjs";

export * from "./graph/data.mjs";
export * from "./graph/dashboard.mjs";
export * from "./graph/meta-boards.mjs";
export * from "./graph/meta-board-store.mjs";
export * from "./graph/sprints.mjs";
export * from "./graph/actions.mjs";
export * from "./graph/assets.mjs";
export * from "./graph/branches.mjs";
export * from "./graph/commit.mjs";
export * from "./graph/checkouts.mjs";
export * from "./graph/checkout-transfer.mjs";
export * from "./graph/review-sync.mjs";
export * from "./graph/landing.mjs";
export * from "./graph/new-patch.mjs";
export * from "./graph/patching.mjs";
export * from "./graph/patch-update.mjs";
export * from "./graph/patch-review.mjs";
export * from "./graph/patch-update-memory.mjs";
export * from "./graph/phab-auth.mjs";
export * from "./graph/reviews.mjs";
export * from "./graph/server.mjs";
export * from "./graph/testing.mjs";

export function createGraphCommand({
  getCheckoutData = getCheckoutGraphData,
  getCheckoutMetadata = getCheckoutGraphMetadata,
  readBundle = readFile,
  write = writeFile,
  makeDir = mkdir,
  open = openUrl,
  startServer = startInteractiveGraphServer,
  waitForClose = waitForInteractiveServerClose,
  makeToken = randomUUID,
  runCommand = run,
  log = console.log,
  forceInteractive = false,
  appConfig = defaultConfig,
  getCheckouts = resolveGraphCheckouts,
  cwd = process.cwd(),
} = {}) {
  return async function graph({
    limit = 80,
    output,
    open: shouldOpen = true,
    comm = true,
    firefox = true,
    diffs = true,
    maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
    interactive = false,
    pageSize = 80,
    port = forceInteractive ? DEFAULT_CONSOLE_PORT : 0,
    closeTabs = true,
  } = {}) {
    const count = Number(limit) || 80;
    const commitPageSize = Number(pageSize) || 80;
    const parsedDiffByteLimit = Number(maxDiffBytes);
    const diffByteLimit = Number.isFinite(parsedDiffByteLimit)
      ? parsedDiffByteLimit
      : DEFAULT_MAX_DIFF_BYTES;
    const isInteractive = forceInteractive || Boolean(interactive);
    const checkouts = getCheckouts({
      cwd,
      config: appConfig,
      comm,
      firefox,
      includeReview: isInteractive,
    });

    if (!checkouts.length) {
      throw new Error("At least one checkout tab must be enabled.");
    }

    const closeTabsOnShutdown = closeTabs !== false && closeTabs !== "false";
    const graphs = await Promise.all(checkouts.map((checkout) => {
      if (isInteractive) {
        return getCheckoutMetadata(checkout);
      }

      return getCheckoutData({
        ...checkout,
        limit: count,
        diffs,
        maxDiffBytes: diffByteLimit,
      });
    }));
    const token = isInteractive ? makeToken() : undefined;
    const html = buildGraphHtml({
      graphs,
      interactive: {
        enabled: isInteractive,
        pageSize: commitPageSize,
        closeTabsOnShutdown,
        aiEnabled: appConfig?.ai?.enabled === true,
        token,
      },
      stylesheetHref: isInteractive
        ? `/assets/${GRAPH_CLIENT_STYLESHEETS[0].output}`
        : GRAPH_CLIENT_STYLESHEETS[0].output,
      scriptSrcs: GRAPH_CLIENT_SCRIPTS.map((script) => (
        isInteractive ? `/assets/${script.output}` : script.output
      )),
    });
    const launcherHtml = isInteractive
      ? buildInteractiveGraphLauncherHtml({
        consolePath: "/",
        tabName: `tb-tools-console-${token}`,
      })
      : undefined;
    const outputPath = getGraphOutputPath(output);

    if (isInteractive) {
      const graphServer = await startServer({
        html,
        launcherHtml,
        graphs,
        token,
        pageSize: commitPageSize,
        port,
        fallbackPort: forceInteractive && Number(port) === DEFAULT_CONSOLE_PORT ? 0 : undefined,
        closeBrowserTabsOnShutdown: closeTabsOnShutdown,
        appConfig,
        runCommand,
      });

      log(`Interactive graph running at ${graphServer.url}`);
      log(closeTabsOnShutdown
        ? "Close the browser tab or press Ctrl-C to stop the server and close browser tabs."
        : "Close the browser tab or press Ctrl-C to stop the server.");

      if (shouldOpen) {
        const launcherUrl = new URL("launch", graphServer.url);

        // An OS-opened tab is browser-owned and cannot be closed with
        // window.close(). The launcher creates the actual console tab, which
        // the shutdown callback can close.
        await open(launcherUrl.href);
      }

      const closeReason = await waitForClose(graphServer.server);
      if (closeReason) {
        log(`Interactive graph stopped: ${closeReason}.`);
      }
      return graphServer.url;
    }

    await makeDir(path.dirname(outputPath), { recursive: true });
    await writeGraphClientAssets({
      outputPath,
      readBundle,
      write,
      makeDir,
    });
    await write(outputPath, html);

    if (shouldOpen) {
      await open(outputPath);
    }

    return outputPath;
  };
}

export default createGraphCommand();
