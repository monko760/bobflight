/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Minimal DOM for rendering a page with react-dom/client in Node (no jsdom in
 * the lockfile). Only what React 18 needs to mount, update and read text:
 * elements, text nodes, attributes, style, select/option values and no-op events.
 */
class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(public nodeType: number, public ownerDocument: FakeDocument | null) {}
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  appendChild(c: FakeNode) { c.parentNode?.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore(c: FakeNode, ref: FakeNode | null) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); c.parentNode = this; return c;
  }
  removeChild(c: FakeNode) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  addEventListener() {}
  removeEventListener() {}
  get textContent(): string { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v) this.appendChild(new FakeText(v, this.ownerDocument));
  }
}
class FakeText extends FakeNode {
  constructor(public nodeValue: string, doc: FakeDocument | null) { super(3, doc); }
  get textContent() { return this.nodeValue; }
  set textContent(v: string) { this.nodeValue = v; }
}
export class FakeElement extends FakeNode {
  attributes = new Map<string, string>();
  style: Record<string, string> & { setProperty(k: string, v: string): void } = Object.assign(Object.create(null), { setProperty(this: Record<string, string>, k: string, v: string) { this[k] = v; } });
  namespaceURI = "http://www.w3.org/1999/xhtml";
  multiple = false;
  selected = false;
  defaultSelected = false;
  disabled = false;
  constructor(public tagName: string, doc: FakeDocument | null) { super(1, doc); }
  get nodeName() { return this.tagName; }
  setAttribute(k: string, v: string) { this.attributes.set(k, String(v)); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  removeAttribute(k: string) { this.attributes.delete(k); }
  hasAttribute(k: string) { return this.attributes.has(k); }
  get value(): string { return this.attributes.get("value") ?? this.textContent; }
  set value(v: string) { this.attributes.set("value", String(v)); }
  get options(): FakeElement[] { return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName === "OPTION"); }
  /** Test helper: every element (depth-first) matching a predicate. */
  findAll(pred: (e: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); out.push(...c.findAll(pred)); }
    return out;
  }
}
export class FakeDocument extends FakeNode {
  body: FakeElement;
  activeElement = null;
  constructor() { super(9, null); this.body = new FakeElement("BODY", this); }
  createElement(tag: string) { return new FakeElement(tag.toUpperCase(), this); }
  createElementNS(_ns: string, tag: string) { return new FakeElement(tag, this); }
  createTextNode(text: string) { return new FakeText(text, this); }
}
/** Installs `window` (no `document`, so React treats the environment as non-DOM for feature probes). */
export function installFakeDom(): { document: FakeDocument; container: FakeElement } {
  const document = new FakeDocument();
  (globalThis as Record<string, unknown>).window = { HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} };
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { document, container };
}
