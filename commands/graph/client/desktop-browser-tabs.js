export function initializeDesktopBrowserTabs() {
  const api = window.commandsBrowser;
  const navigation = document.querySelector(".console-navigation");
  if (!api || !navigation) return;
  document.body.classList.add("desktop-browser-host");
  let dialogOpen;
  const updateDialogState = () => {
    const open = Boolean(document.querySelector("dialog[open]"));
    if (open === dialogOpen) return;
    dialogOpen = open;
    api.overlay?.(open);
  };
  new MutationObserver(updateDialogState).observe(document.body, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["open"],
  });
  updateDialogState();
  const tabs = document.createElement("span");
  tabs.className = "desktop-browser-tabs";
  navigation.append(tabs);
  const toolbar = document.createElement("div");
  toolbar.className = "desktop-browser-toolbar";
  toolbar.hidden = true;
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Page navigation");
  toolbar.innerHTML = `<button type="button" data-browser-action="back" aria-label="Back">←</button>
    <button type="button" data-browser-action="forward" aria-label="Forward">→</button>
    <button type="button" data-browser-action="reload" aria-label="Reload">↻</button>
    <span class="desktop-browser-address"></span>`;
  navigation.closest("header").append(toolbar);
  const layout = () => api.layout(toolbar.hidden
    ? navigation.closest("header").getBoundingClientRect().bottom : toolbar.getBoundingClientRect().bottom);
  new ResizeObserver(layout).observe(document.querySelector("header"));
  window.addEventListener("resize", layout);
  document.addEventListener("click", event => {
    if (event.target.closest(".graph-menu-button, .graph-menu-command, .update-action, .mach-action")) api.action("select", "console");
  }, true);
  navigation.addEventListener("click", event => {
    if (event.target.closest(".console-view-tab")) api.action("select", "console");
  });
  toolbar.addEventListener("click", event => {
    const button = event.target.closest("[data-browser-action]");
    if (button) api.action(button.dataset.browserAction);
  });
  api.onState(state => {
    const external = state.activeId !== "console";
    toolbar.hidden = !external;
    document.body.classList.toggle("desktop-browser-active", external);
    toolbar.querySelector(".desktop-browser-address").textContent = state.address;
    for (const [action, enabled] of [["back", state.canGoBack], ["forward", state.canGoForward], ["reload", state.canReload]]) {
      toolbar.querySelector(`[data-browser-action="${action}"]`).disabled = !enabled;
    }
    tabs.replaceChildren();
    for (const tab of state.tabs) {
      const item = document.createElement("span");
      item.className = `desktop-browser-tab${tab.id === state.activeId ? " active" : ""}`;
      const select = document.createElement("button");
      select.type = "button";
      select.className = `tab${tab.id === state.activeId ? " active" : ""}`;
      select.dataset.tabId = tab.id;
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(tab.id === state.activeId));
      select.textContent = tab.title;
      select.title = tab.url;
      select.addEventListener("click", () => api.action("select", tab.id));
      item.addEventListener("contextmenu", event => {
        event.preventDefault(); api.action("tab-menu", tab.id);
      });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "desktop-browser-tab-close";
      close.setAttribute("aria-label", `Close ${tab.title}`);
      close.textContent = "×";
      close.addEventListener("click", () => api.action("close", tab.id));
      item.append(select, close);
      tabs.append(item);
    }
    layout();
  });
}
