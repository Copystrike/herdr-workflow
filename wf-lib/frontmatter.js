// A lightweight YAML front-matter parser: nested maps by indentation,
// lists of maps or scalars, inline "# comments", quoted strings, null/true/false and integers.
// Intentionally minimal (no block scalars or flow collections).

// Splits "---\n<yaml>\n---\n<body>". Returns { data: null, body: text } without front-matter.
export function splitFrontMatter(text) {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!t.startsWith("---\n")) return { yaml: null, body: t };
  const end = t.indexOf("\n---", 4);
  if (end < 0) return { yaml: null, body: t };
  const after = t.indexOf("\n", end + 4);
  return { yaml: t.slice(4, end), body: after < 0 ? "" : t.slice(after + 1) };
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /\s/.test(s[i - 1]) || s[i - 1] === ":") q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d{1,15}$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return s;
}

export function parseYaml(yaml) {
  const lines = yaml.split("\n")
    .map(l => stripComment(l).replace(/\s+$/, ""))
    .filter(l => l.trim() !== "")
    .map(l => ({ indent: l.length - l.trimStart().length, text: l.trimStart() }));
  let i = 0;

  function block(indent) {
    if (i >= lines.length) return null;
    return lines[i].text.startsWith("- ") || lines[i].text === "-" ? list(lines[i].indent) : map(indent);
  }

  function map(indent, into = {}) {
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const { text } = lines[i];
      const m = text.match(/^([^:]+?):(?:\s+(.*))?$/) ?? text.match(/^([^:]+?):$/);
      if (!m) throw new Error(`front-matter line ${i + 1}: expected "key: value", got "${text}"`);
      i++;
      const key = m[1].trim(), rest = m[2];
      if (rest !== undefined && rest !== "") into[key] = scalar(rest);
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith("- "))))
        into[key] = block(lines[i].indent);
      else into[key] = null;
    }
    return into;
  }

  function list(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith("- ") || lines[i].text === "-")) {
      const rest = lines[i].text === "-" ? "" : lines[i].text.slice(2);
      const itemIndent = indent + 2;
      if (/^[^:"']+:(\s|$)/.test(rest)) {
        // "- key: value" opens a map whose keys continue at the item's indent.
        lines[i] = { indent: itemIndent, text: rest };
        out.push(map(itemIndent));
      } else {
        i++;
        if (rest === "" && i < lines.length && lines[i].indent > indent) out.push(block(lines[i].indent));
        else out.push(scalar(rest));
      }
    }
    return out;
  }

  const top = lines.length ? lines[0].indent : 0;
  const data = map(top);
  if (i < lines.length) throw new Error(`front-matter line ${i + 1}: unexpected indentation`);
  return data;
}

export function parseFrontMatter(text) {
  const { yaml, body } = splitFrontMatter(text);
  return { data: yaml === null ? null : parseYaml(yaml), body };
}

// Markdown "## Heading" sections of a body: [{ title, text }] in order, text without the heading.
export function sections(body) {
  const out = [];
  let cur = null, fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (m) { cur = { title: m[1].trim(), lines: [] }; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out.map(s => ({ title: s.title, text: s.lines.join("\n").trim() }));
}
