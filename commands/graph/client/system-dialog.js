const dialog = document.getElementById("system-dialog");
const title = dialog?.querySelector(".system-dialog-title");
const message = dialog?.querySelector(".system-dialog-message");
const choices = dialog?.querySelector(".system-dialog-choices");
const cancel = dialog?.querySelector(".system-dialog-cancel");
const confirm = dialog?.querySelector(".system-dialog-confirm");

const requests = [];
let activeRequest;

function closeActiveDialog(value = "") {
  if (!dialog?.open) {
    return;
  }

  dialog.close(value);
}

function presentNextDialog() {
  if (activeRequest || !dialog || !requests.length) {
    return;
  }

  activeRequest = requests.shift();
  const {
    cancelLabel = "Cancel",
    choices: dialogChoices = [],
    confirmLabel = "OK",
    message: dialogMessage = "",
    title: dialogTitle = "Thunderbird Desktop Console",
  } = activeRequest.options;

  title.textContent = dialogTitle;
  message.textContent = dialogMessage;
  choices.replaceChildren();

  for (const choice of dialogChoices) {
    const button = document.createElement("button");

    button.className = "system-dialog-choice";
    button.type = "button";
    button.dataset.value = choice.value;
    button.textContent = choice.label;
    if (choice.description) {
      const description = document.createElement("span");

      description.textContent = choice.description;
      button.append(description);
    }
    choices.append(button);
  }

  choices.hidden = !dialogChoices.length;
  cancel.hidden = !activeRequest.options.cancelable;
  cancel.textContent = cancelLabel;
  confirm.hidden = Boolean(dialogChoices.length);
  confirm.textContent = confirmLabel;
  dialog.classList.toggle("danger", activeRequest.options.danger === true);
  dialog.showModal();
  (dialogChoices.length ? choices.querySelector("button") : confirm).focus();
}

function resolveActiveDialog(value = "") {
  if (!activeRequest) {
    return;
  }

  const { resolve } = activeRequest;

  activeRequest = undefined;
  resolve(value);
  presentNextDialog();
}

function requestSystemDialog(options) {
  return new Promise((resolve) => {
    requests.push({ options, resolve });
    presentNextDialog();
  });
}

export async function showSystemNotice({
  title = "Thunderbird Desktop Console",
  message = "",
  confirmLabel = "OK",
} = {}) {
  await requestSystemDialog({
    title,
    message,
    confirmLabel,
    cancelable: false,
  });
}

export async function showSystemConfirmation({
  title = "Confirm action",
  message = "",
  confirmLabel = "Continue",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  const value = await requestSystemDialog({
    title,
    message,
    confirmLabel,
    cancelLabel,
    cancelable: true,
    danger,
  });

  return value === "confirm";
}

export function showSystemChoice({
  title = "Choose an action",
  message = "",
  choices = [],
  cancelLabel = "Cancel",
} = {}) {
  return requestSystemDialog({
    title,
    message,
    choices,
    cancelLabel,
    cancelable: true,
  });
}

if (dialog) {
  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("button");

    if (!button || !dialog.contains(button)) {
      return;
    }

    if (button === cancel) {
      closeActiveDialog();
      return;
    }

    if (button === confirm) {
      closeActiveDialog("confirm");
      return;
    }

    if (button.classList.contains("system-dialog-choice")) {
      closeActiveDialog(button.dataset.value || "");
    }
  });
  dialog.addEventListener("cancel", () => {
    dialog.returnValue = "";
  });
  dialog.addEventListener("close", () => {
    resolveActiveDialog(dialog.returnValue);
  });
}
