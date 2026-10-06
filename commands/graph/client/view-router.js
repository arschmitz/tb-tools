const META_BOARDS_ROUTE = /^#meta-boards(?:\/([^/]+))?$/;
const SPRINT_ROUTE = /^#sprints\/([^/]+)\/(\d+)(?:\/(overview|planning))?$/;

export function formatConsoleRoute(route) {
  if (route?.view === "dashboard") {
    return "#dashboard";
  }

  if (route?.view === "phabricator-cache") {
    return "#phabricator-cache";
  }

  if (route?.view === "meta-boards") {
    return route.boardId
      ? `#meta-boards/${encodeURIComponent(route.boardId)}`
      : "#meta-boards";
  }

  if (route?.view === "sprint") {
    const view = route.sprintView === "planning" ? "/planning" : "/overview";

    return `#sprints/${encodeURIComponent(route.boardId)}/${encodeURIComponent(route.sprintId)}${view}`;
  }

  return "";
}

export function parseConsoleRoute(hash = "") {
  if (hash === "#dashboard") {
    return { view: "dashboard" };
  }

  if (hash === "#phabricator-cache") {
    return { view: "phabricator-cache" };
  }

  const match = hash.match(META_BOARDS_ROUTE);

  const sprintMatch = hash.match(SPRINT_ROUTE);

  if (sprintMatch) {
    try {
      return {
        boardId: decodeURIComponent(sprintMatch[1]),
        sprintId: sprintMatch[2],
        sprintView: sprintMatch[3] || "overview",
        view: "sprint",
      };
    } catch {
      return null;
    }
  }

  if (!match) {
    return null;
  }

  try {
    return {
      boardId: match[1] ? decodeURIComponent(match[1]) : "",
      view: "meta-boards",
    };
  } catch {
    return null;
  }
}

export function getConsoleRoute() {
  return parseConsoleRoute(window.location.hash);
}

export function setConsoleRoute(route) {
  const hash = formatConsoleRoute(route);

  if (window.location.hash === hash) {
    return;
  }

  const url = new URL(window.location.href);

  url.hash = hash;
  window.history.pushState(null, "", url);
}

export function clearConsoleRoute() {
  setConsoleRoute(null);
}
