// Minimal in-memory React renderer for interaction tests in the Node test
// environment (the project has no jsdom). Built on react-reconciler, which is
// already installed with React Three Fiber. Host elements become plain
// objects ({ type, props, children }), so tests can find a button by its
// props or text and call its handlers inside act().
import React from "react";
import Reconciler from "react-reconciler";

const DEFAULT_EVENT_PRIORITY = 16;

function removeFrom(list, child) {
  const index = list.indexOf(child);
  if (index >= 0) list.splice(index, 1);
}

function insertBefore(list, child, before) {
  removeFrom(list, child);
  const index = list.indexOf(before);
  list.splice(index >= 0 ? index : list.length, 0, child);
}

function createNodeStub(type, props) {
  // Enough of an element for refs used by components under test.
  return {
    type,
    props,
    children: [],
    focused: false,
    focus() {
      this.focused = true;
    },
    blur() {
      this.focused = false;
    },
    scrollIntoView() {},
    setSelectionRange() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    listeners: {},
    addEventListener(eventName, listener) {
      (this.listeners[eventName] ||= new Set()).add(listener);
    },
    removeEventListener(eventName, listener) {
      this.listeners[eventName]?.delete(listener);
    },
    /** Test helper: runs listeners added with addEventListener. */
    dispatch(eventName, event = {}) {
      [...(this.listeners[eventName] || [])].forEach((listener) => listener({ type: eventName, target: this, ...event }));
    },
    contains(node) {
      if (node === this) return true;
      return this.children.some((child) => typeof child.contains === "function" && child.contains(node));
    },
    getElementsByClassName(className) {
      const found = [];
      const visit = (node) => {
        (node.children || []).forEach((child) => {
          if (!child.type) return;
          if (String(child.props?.className || "").split(/\s+/).includes(className)) found.push(child);
          visit(child);
        });
      };
      visit(this);
      return found;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    offsetWidth: 0,
    scrollWidth: 0,
    style: {},
  };
}

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: false,
  noTimeout: -1,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  now: () => Date.now(),
  getRootHostContext: () => ({}),
  getChildHostContext: (parent) => parent,
  getPublicInstance: (instance) => instance,
  getCurrentEventPriority: () => DEFAULT_EVENT_PRIORITY,
  prepareForCommit: () => null,
  resetAfterCommit: () => {},
  preparePortalMount: () => {},
  createInstance: (type, props) => createNodeStub(type, props),
  createTextInstance: (text) => ({ text: String(text) }),
  appendInitialChild: (parent, child) => parent.children.push(child),
  appendChild: (parent, child) => {
    removeFrom(parent.children, child);
    parent.children.push(child);
  },
  appendChildToContainer: (container, child) => {
    removeFrom(container.children, child);
    container.children.push(child);
  },
  insertBefore: (parent, child, before) => insertBefore(parent.children, child, before),
  insertInContainerBefore: (container, child, before) => insertBefore(container.children, child, before),
  removeChild: (parent, child) => removeFrom(parent.children, child),
  removeChildFromContainer: (container, child) => removeFrom(container.children, child),
  clearContainer: (container) => {
    container.children = [];
  },
  finalizeInitialChildren: () => false,
  prepareUpdate: () => true,
  commitUpdate: (instance, _payload, _type, _oldProps, newProps) => {
    instance.props = newProps;
  },
  commitTextUpdate: (instance, _oldText, newText) => {
    instance.text = String(newText);
  },
  commitMount: () => {},
  shouldSetTextContent: () => false,
  resetTextContent: () => {},
  hideInstance: () => {},
  unhideInstance: () => {},
  hideTextInstance: () => {},
  unhideTextInstance: () => {},
  detachDeletedInstance: () => {},
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
};

const reconciler = Reconciler(hostConfig);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Some Carbon effects test `node instanceof HTMLElement`; host stubs never are.
if (typeof globalThis.HTMLElement === "undefined") {
  globalThis.HTMLElement = class HTMLElement {};
}

/** React's act() (sync or async callback), usable without react-dom. */
export async function act(callback) {
  let result;
  await React.unstable_act(async () => {
    result = await callback();
  });
  return result;
}

export function textOf(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.children || []).map(textOf).join("");
}

function walk(node, visit) {
  if (!node) return;
  if (node.type) visit(node);
  (node.children || []).forEach((child) => walk(child, visit));
}

/** Renders `element` and returns query helpers over the host tree. */
export async function renderTree(element) {
  const container = { children: [] };
  const root = reconciler.createContainer(container, 0, null, false, null, "", () => {}, null);
  await act(() => {
    reconciler.updateContainer(element, root, null, null);
  });

  const all = (predicate) => {
    const found = [];
    container.children.forEach((child) => walk(child, (node) => predicate(node) && found.push(node)));
    return found;
  };

  const api = {
    container,
    all,
    find(predicate) {
      return all(predicate)[0] || null;
    },
    text: () => container.children.map(textOf).join(""),
    /** First host element of `type` whose text or aria-label contains `label`. */
    getByLabel(type, label) {
      const match = all(
        (node) =>
          node.type === type &&
          (String(node.props["aria-label"] || "").includes(label) || textOf(node).includes(label))
      )[0];
      if (!match) throw new Error(`No <${type}> labelled "${label}". Rendered text: ${api.text()}`);
      return match;
    },
    async rerender(nextElement) {
      await act(() => {
        reconciler.updateContainer(nextElement, root, null, null);
      });
    },
    async unmount() {
      await act(() => {
        reconciler.updateContainer(null, root, null, null);
      });
    },
  };
  return api;
}

/** Calls a host element's event handler inside act(). */
export async function fire(node, handlerName, event = {}) {
  const handler = node?.props?.[handlerName];
  if (typeof handler !== "function") throw new Error(`Element has no ${handlerName} handler`);
  const syntheticEvent = {
    preventDefault() {},
    stopPropagation() {},
    target: node,
    currentTarget: node,
    ...event,
  };
  return act(() => handler(syntheticEvent));
}
