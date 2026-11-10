/**
 * A small XML reader and writer for the exchange formats the viewer reads and writes (BCF).
 * Namespaces are dropped from names; comments, processing instructions and the DOCTYPE are
 * skipped. Not a validating parser: the callers check what they need.
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The element's own text, CDATA included, entities decoded. */
  text: string;
}

export class XmlError extends Error {}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c]};`);
}

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === 'xmlns' || m[1].startsWith('xmlns:')) continue;
    attrs[localName(m[1])] = unescapeXml(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** The document element. Throws `XmlError` on a document whose tags do not nest. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  // Attribute values may hold '>', so a tag runs to the first '>' outside quotes.
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const top = () => stack[stack.length - 1];
  while ((m = token.exec(xml)) !== null) {
    if (m.index > last && stack.length > 1) top().text += unescapeXml(xml.slice(last, m.index));
    last = token.lastIndex;
    if (m[1] !== undefined) {
      top().text += m[1];
    } else if (m[2] !== undefined) {
      if (stack.length < 2 || top().tag !== localName(m[2])) throw new XmlError(`Etiqueta de cierre inesperada: ${m[2]}.`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const node: XmlNode = { tag: localName(m[3]), attrs: parseAttributes(m[4]), children: [], text: '' };
      top().children.push(node);
      if (m[5] !== '/') stack.push(node);
    }
  }
  if (stack.length !== 1) throw new XmlError(`Falta el cierre de ${top().tag}.`);
  if (root.children.length !== 1) throw new XmlError('El documento XML no tiene un único elemento raíz.');
  return root.children[0];
}

export const child = (node: XmlNode | undefined, tag: string): XmlNode | undefined =>
  node?.children.find((c) => c.tag === tag);

export const children = (node: XmlNode | undefined, tag: string): XmlNode[] =>
  node ? node.children.filter((c) => c.tag === tag) : [];

/** The trimmed text of a child, or `undefined` when it is missing or blank. */
export function childText(node: XmlNode | undefined, tag: string): string | undefined {
  const text = child(node, tag)?.text.trim();
  return text ? text : undefined;
}

/** An element to write: text or children, and attributes whose `undefined` values are left out. */
export interface XmlOut {
  tag: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  children?: (XmlOut | null | undefined | false)[];
  text?: string;
}

/** A leaf with text, or nothing when the text is `undefined`. */
export const leaf = (tag: string, text: string | number | undefined): XmlOut | null =>
  text === undefined ? null : { tag, text: String(text) };

function write(node: XmlOut, indent: string, out: string[]): void {
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join('');
  const kids = (node.children ?? []).filter((c): c is XmlOut => !!c);
  if (node.text !== undefined) {
    out.push(`${indent}<${node.tag}${attrs}>${escapeXml(node.text)}</${node.tag}>`);
  } else if (kids.length === 0) {
    out.push(`${indent}<${node.tag}${attrs}/>`);
  } else {
    out.push(`${indent}<${node.tag}${attrs}>`);
    for (const kid of kids) write(kid, indent + '  ', out);
    out.push(`${indent}</${node.tag}>`);
  }
}

export function writeXml(root: XmlOut): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  write(root, '', out);
  return out.join('\n') + '\n';
}
