function getStatus(response) {
  const status = response.status ? String(response.status) : "";
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return `${status}${statusText}`.trim();
}

function getApiErrorDetail(data, fallback) {
  if (!data) {
    return fallback;
  }

  if (typeof data === "string") {
    return data;
  }

  if (data.error_info) {
    return data.error_info;
  }

  if (data.message) {
    return data.message;
  }

  if (typeof data.error === "string") {
    return data.error;
  }

  if (data.error?.message) {
    return data.error.message;
  }

  return fallback || JSON.stringify(data);
}

function getErrorMessage(label, response, data, fallback) {
  const status = response.ok ? "" : getStatus(response);
  const detail = getApiErrorDetail(data, fallback);
  const parts = [label, "failed"];

  if (status) {
    parts.push(`(${status})`);
  }

  return `${parts.join(" ")}${detail ? `: ${detail}` : ""}`;
}

export async function readJsonResponse(response, label) {
  const text = await response.text();
  let data;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      if (!response.ok) {
        throw new Error(getErrorMessage(label, response, text, text), { cause: error });
      }

      throw new Error(`${label} returned invalid JSON: ${text}`, { cause: error });
    }
  } else {
    data = {};
  }

  if (!response.ok) {
    throw new Error(getErrorMessage(label, response, data, text));
  }

  if (data.error_code) {
    throw new Error(getErrorMessage(label, response, data));
  }

  if (data.error === true) {
    throw new Error(getErrorMessage(label, response, data));
  }

  return data;
}
