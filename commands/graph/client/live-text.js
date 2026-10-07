// Keep existing text nodes so status polls do not clear browser selections.
export function setLiveText(element, value) {
  const text = String(value ?? "");
  const previous = element.textContent;
  if (text === previous) return false;
  if (text.startsWith(previous)) {
    element.append(document.createTextNode(text.slice(previous.length)));
  } else {
    element.textContent = text;
  }
  return true;
}

export function hasSelectedText(element) {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}

// Reuse unchanged rows, including their selections and disclosure state.
export function replaceChangedChildren(element, ...children) {
  let changed = false;
  children.forEach((child, index) => {
    const previous = element.childNodes[index];
    if (previous?.isEqualNode(child)) return;
    if (previous?.nodeType === 3 && child.nodeType === 3 && child.data.startsWith(previous.data)) {
      previous.appendData(child.data.slice(previous.length));
    } else if (previous?.nodeType === 1 && child.nodeType === 1 &&
        previous.cloneNode().isEqualNode(child.cloneNode()) &&
        [...previous.childNodes, ...child.childNodes].every(node => node.nodeType === 3) &&
        child.textContent.startsWith(previous.textContent)) {
      setLiveText(previous, child.textContent);
    } else if (previous) {
      previous.replaceWith(child);
    } else {
      element.append(child);
    }
    changed = true;
  });
  while (element.childNodes.length > children.length) {
    element.lastChild.remove();
    changed = true;
  }
  return changed;
}
