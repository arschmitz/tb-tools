import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import openUrl from "open";
import { run } from "../lib/utils.mjs";
import {
  DEFAULT_MAX_DIFF_BYTES,
  GRAPH_CLIENT_SCRIPTS,
  GRAPH_CLIENT_STYLESHEETS,
} from "./graph/constants.mjs";
import { getCheckoutGraphData, getCheckoutGraphMetadata } from "./graph/data.mjs";
import { getGraphOutputPath, writeGraphClientAssets } from "./graph/assets.mjs";
import { startInteractiveGraphServer, waitForInteractiveServerClose } from "./graph/server.mjs";
import { buildGraphHtml } from "./graph/templates.mjs";

export * from "./graph/data.mjs";
export * from "./graph/actions.mjs";
export * from "./graph/assets.mjs";
export * from "./graph/landing.mjs";
export * from "./graph/new-patch.mjs";
export * from "./graph/patching.mjs";
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
    port = 0,
  } = {}) {
    const count = Number(limit) || 80;
    const commitPageSize = Number(pageSize) || 80;
    const parsedDiffByteLimit = Number(maxDiffBytes);
    const diffByteLimit = Number.isFinite(parsedDiffByteLimit)
      ? parsedDiffByteLimit
      : DEFAULT_MAX_DIFF_BYTES;
    const checkouts = [];

    if (comm) {
      checkouts.push({ label: "comm", cwd: "." });
    }

    if (firefox) {
      checkouts.push({ label: "firefox", cwd: ".." });
    }

    if (!checkouts.length) {
      throw new Error("At least one checkout tab must be enabled.");
    }

    const isInteractive = forceInteractive || Boolean(interactive);
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
        token,
      },
      stylesheetHref: isInteractive
        ? `/assets/${GRAPH_CLIENT_STYLESHEETS[0].output}`
        : GRAPH_CLIENT_STYLESHEETS[0].output,
      scriptSrcs: GRAPH_CLIENT_SCRIPTS.map((script) => (
        isInteractive ? `/assets/${script.output}` : script.output
      )),
    });
    const outputPath = getGraphOutputPath(output);

    if (isInteractive) {
      const graphServer = await startServer({
        html,
        graphs,
        token,
        pageSize: commitPageSize,
        maxDiffBytes: diffByteLimit,
        port,
        runCommand,
      });

      log(`Interactive graph running at ${graphServer.url}`);
      log("Close the browser tab or press Ctrl-C to stop the server.");

      if (shouldOpen) {
        await open(graphServer.url);
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
