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

function getRetryAfterMilliseconds(response) {
  const value = response.headers?.get?.("retry-after");

  if (!value) {
    return 0;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function createApiError(label, response, data, fallback, options) {
  const error = new Error(getErrorMessage(label, response, data, fallback), options);

  error.statusCode = response.status || 0;
  error.statusText = response.statusText || "";
  error.retryAfterMs = getRetryAfterMilliseconds(response);
  error.responseData = data;

  return error;
}

export async function readJsonResponse(response, label) {
  const text = await response.text();
  let data;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      if (!response.ok) {
        throw createApiError(label, response, text, text, { cause: error });
      }

      throw new Error(`${label} returned invalid JSON: ${text}`, { cause: error });
    }
  } else {
    data = {};
  }

  if (!response.ok) {
    throw createApiError(label, response, data, text);
  }

  if (data.error_code) {
    throw createApiError(label, response, data);
  }

  if (data.error === true) {
    throw createApiError(label, response, data);
  }

  return data;
}
