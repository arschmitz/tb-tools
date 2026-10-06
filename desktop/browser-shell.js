/* global document, window */
const api = window.commandsBrowser;
const tabs = document.getElementById("tabs");
const address = document.getElementById("address");

function render(state) {
  document.getElementById("back").disabled = !state.canGoBack;
  document.getElementById("forward").disabled = !state.canGoForward;
  document.getElementById("reload").disabled = state.activeId === "console";
  document.getElementById("open-browser").disabled = state.activeId === "console";
  document.getElementById("close").disabled = state.activeId === "console";
  address.textContent = state.address || "Console";
  address.title = state.address || "Console";
  tabs.replaceChildren();
  for (const tab of state.tabs) {
    const item = document.createElement("div");
    item.className = `tab${tab.id === state.activeId ? " active" : ""}`;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "tab-select";
    select.dataset.action = "select";
    select.dataset.tabId = tab.id;
    select.role = "tab";
    select.setAttribute("aria-selected", String(tab.id === state.activeId));
    select.textContent = tab.title;
    select.title = tab.url || tab.title;
    item.append(select);
    if (tab.id !== "console") {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.dataset.action = "close";
      close.dataset.tabId = tab.id;
      close.setAttribute("aria-label", `Close ${tab.title}`);
      close.textContent = "×";
      item.append(close);
    }
    tabs.append(item);
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (button && !button.disabled) api.action(button.dataset.action, button.dataset.tabId);
});
api.onState(render);
