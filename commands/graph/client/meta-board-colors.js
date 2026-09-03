const ASSIGNEE_PILL_FOREGROUND = "#101418";
const ASSIGNEE_PILL_SOURCE_WEIGHT = 0.24;

function getGeneratedColor(index) {
  const hue = (index * 137.508) % 360;

  return hslToHex(hue, 0.68, 0.42);
}

function hslToHex(hue, saturation, lightness) {
  const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
  const segment = (hue / 60) % 6;
  const intermediate = chroma * (1 - Math.abs((segment % 2) - 1));
  const match = lightness - (chroma / 2);
  const channels = [
    [chroma, intermediate, 0],
    [intermediate, chroma, 0],
    [0, chroma, intermediate],
    [0, intermediate, chroma],
    [intermediate, 0, chroma],
    [chroma, 0, intermediate],
  ][Math.floor(segment)];

  return `#${channels.map((channel) => Math.round((channel + match) * 255)
    .toString(16).padStart(2, "0")).join("")}`;
}

function hexToChannels(color) {
  const normalized = String(color).replace(/^#/, "");

  if (!/^[\da-f]{6}$/i.test(normalized)) {
    throw new Error(`Expected a six-digit hex color, received ${color}.`);
  }

  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
}

function channelsToHex(channels) {
  return `#${channels.map((channel) => Math.round(channel)
    .toString(16).padStart(2, "0")).join("")}`;
}

function mixWithWhite(color, sourceWeight) {
  return channelsToHex(hexToChannels(color)
    .map((channel) => (channel * sourceWeight) + (255 * (1 - sourceWeight))));
}

function getRelativeLuminance(color) {
  return hexToChannels(color)
    .map((channel) => {
      const value = channel / 255;

      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce((luminance, channel, index) => (
      luminance + (channel * [0.2126, 0.7152, 0.0722][index])
    ), 0);
}

export function getContrastRatio(first, second) {
  const firstLuminance = getRelativeLuminance(first);
  const secondLuminance = getRelativeLuminance(second);

  return (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05);
}

export function getAccessibleAssigneePillStyle(color) {
  const background = mixWithWhite(color, ASSIGNEE_PILL_SOURCE_WEIGHT);
  const foreground = ASSIGNEE_PILL_FOREGROUND;

  if (getContrastRatio(foreground, background) < 7) {
    throw new Error(`Assignee pill contrast is below WCAG AAA for ${color}.`);
  }

  return { accent: color, background, foreground };
}

export function createColorAssignments(values, palette) {
  const uniqueValues = Array.from(new Set(values
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(String)))
    .sort((first, second) => first.localeCompare(second, undefined, { numeric: true }));

  return new Map(uniqueValues.map((value, index) => [
    value,
    palette[index] || getGeneratedColor(index),
  ]));
}
