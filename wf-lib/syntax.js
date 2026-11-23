// Fast, zero-dependency syntax highlighting for wf-diff and wf-explain:
//   - Maps file extensions to EditorState language IDs and lightweight line tokenizer modes
//   - Derives semantic syntax colors directly from the active Herdr theme() palette
//     (so Monospace Dark or any custom Herdr theme automatically colors files & diffs).

const EDITOR_LANG = {
  js: "js", mjs: "js", cjs: "js", jsx: "js",
  ts: "js", mts: "js", cts: "js", tsx: "js",
  json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml", toml: "yaml",
  html: "html", htm: "html", xml: "html", svg: "html", svelte: "html", vue: "html", cshtml: "html", razor: "html",
  css: "css", scss: "css", less: "css",
  rs: "rust",
  py: "python",
  go: "go",
  sh: "bash", bash: "bash", zsh: "bash",
  c: "c", h: "c", cpp: "c", hpp: "c", cs: "c", java: "c", kt: "c",
  md: "markdown", mdx: "markdown",
  sql: "sql",
  nix: "nix",
};

const KEYWORDS = new Set([
  // JS / TS / C# / Rust / Go / Java / Python / SQL / Nix
  "import", "export", "from", "default", "as", "const", "let", "var", "function", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch",
  "finally", "throw", "new", "class", "extends", "implements", "interface", "type", "enum",
  "public", "private", "protected", "internal", "static", "readonly", "override", "virtual",
  "abstract", "sealed", "partial", "async", "await", "namespace", "using", "record", "struct",
  "fn", "pub", "mod", "use", "impl", "trait", "match", "mut", "ref", "loop", "where", "move",
  "def", "elif", "except", "pass", "lambda", "with", "yield", "in", "is", "not", "and", "or",
  "package", "func", "go", "defer", "chan", "select", "range", "fallthrough",
  "true", "false", "null", "undefined", "nil", "None", "True", "False", "this", "self", "super", "base",
  "void", "int", "long", "float", "double", "decimal", "bool", "string", "char", "byte", "object",
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "ON", "AND", "OR", "NOT", "INSERT",
  "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "ORDER", "BY",
]);

const HASH_COMMENT_EXTS = new Set(["py", "sh", "bash", "zsh", "yml", "yaml", "toml", "nix", "rb", "pl", "r", "dockerfile", "makefile"]);
const DASH_COMMENT_EXTS = new Set(["sql", "lua", "hs"]);
const MARKUP_EXTS = new Set(["html", "htm", "xml", "svg", "svelte", "vue", "jsx", "tsx", "cshtml", "razor"]);

export function extOf(path) {
  const base = String(path || "").split("/").pop() || "";
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile") return lower;
  const idx = lower.lastIndexOf(".");
  return idx > 0 ? lower.slice(idx + 1) : "";
}

export function languageForPath(path) {
  return EDITOR_LANG[extOf(path)] || "txt";
}

// Semantic syntax color map derived from the active Herdr theme() object.
// Compatible with both EditorState.new({ syntax }) and our diff line renderer.
export function syntaxPalette(t) {
  const th = t || {};
  return {
    keyword: th.ansi5 || th.accent || "#a87ffb",
    string: th.ansi2 || "#17b877",
    "string.escape": th.ansi6 || "#25a6e9",
    comment: th.dim || "#637286",
    function: th.ansi4 || "#708fff",
    type: th.ansi3 || "#ffa23e",
    number: th.ansi6 || "#25a6e9",
    constant: th.ansi6 || "#25a6e9",
    boolean: th.ansi1 || "#f76769",
    tag: th.ansi1 || "#f76769",
    attr: th.ansi3 || "#ffa23e",
    variable: th.foreground || "#d9dfe7",
    operator: th.muted || "#8b98a9",
    punctuation: th.muted || "#8b98a9",
    plain: th.foreground || "#d9dfe7",
  };
}

const isDigitCode = c => c >= 48 && c <= 57;
const isAlphaCode = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isIdentStartCode = c => isAlphaCode(c) || c === 95 || c === 36;
const isIdentPartCode = c => isIdentStartCode(c) || isDigitCode(c);
const isHexCode = c => isDigitCode(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) || c === 95;

// Tokenizes a single line of code into [{ kind, text }] for fast GPUI rendering.
// Zero-allocation char-code scanner (no per-char substring/regex) so even large files stay instant in QuickJS.
export function tokenizeCodeLine(line, path = "") {
  const s = String(line ?? "");
  if (!s) return [];
  if (s.length > 500) return [{ kind: "plain", text: s }];

  const ext = extOf(path);
  const hashComments = HASH_COMMENT_EXTS.has(ext);
  const dashComments = DASH_COMMENT_EXTS.has(ext);
  const isJson = ext === "json" || ext === "jsonc";
  const isMarkup = MARKUP_EXTS.has(ext);
  const isMd = ext === "md" || ext === "mdx";

  if (isMd) {
    if (/^\s*#{1,6}\s/.test(s)) return [{ kind: "keyword", text: s }];
    if (/^\s*```/.test(s)) return [{ kind: "comment", text: s }];
    if (/^\s*[-*+]\s/.test(s)) {
      const m = /^(\s*[-*+]\s)(.*)$/.exec(s);
      return [{ kind: "type", text: m[1] }, { kind: "plain", text: m[2] }];
    }
  }

  const tokens = [];
  const push = (kind, text) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === kind) prev.text += text;
    else tokens.push({ kind, text });
  };

  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    const code = s.charCodeAt(i);

    // Line & block comments
    if (ch === "/" && s[i + 1] === "/") {
      push("comment", s.slice(i));
      break;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end >= 0) {
        push("comment", s.slice(i, end + 2));
        i = end + 2;
        continue;
      }
      push("comment", s.slice(i));
      break;
    }
    if (hashComments && ch === "#") {
      push("comment", s.slice(i));
      break;
    }
    if (dashComments && ch === "-" && s[i + 1] === "-") {
      push("comment", s.slice(i));
      break;
    }

    // Strings ("...", '...', `...`)
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (s[j] === "\\") { j += 2; continue; }
        if (s[j] === quote) { j++; break; }
        j++;
      }
      const raw = s.slice(i, j);
      let kind = "string";
      if (isJson && quote === '"') {
        let k = j;
        while (k < n && s[k] === " ") k++;
        if (s[k] === ":") kind = "function";
      }
      push(kind, raw);
      i = j;
      continue;
    }

    // HTML / JSX / XML tags (<div, </div, <Component)
    if (isMarkup && ch === "<") {
      let j = i + 1;
      if (j < n && s[j] === "/") j++;
      if (j < n && isAlphaCode(s.charCodeAt(j))) {
        j++;
        while (j < n) {
          const c = s.charCodeAt(j);
          if (isIdentPartCode(c) || c === 45 || c === 46) j++;
          else break;
        }
        push("tag", s.slice(i, j));
        i = j;
        continue;
      }
    }

    // Decorators / C# attributes / CSS @rules
    if (ch === "@" && i + 1 < n && isIdentStartCode(s.charCodeAt(i + 1))) {
      let j = i + 2;
      while (j < n && isIdentPartCode(s.charCodeAt(j))) j++;
      push("attr", s.slice(i, j));
      i = j;
      continue;
    }

    // Numbers (0x..., 123, 0.05)
    if (isDigitCode(code) && (i === 0 || !isIdentStartCode(s.charCodeAt(i - 1)))) {
      let j = i + 1;
      if (ch === "0" && (s[j] === "x" || s[j] === "X")) {
        j++;
        while (j < n && isHexCode(s.charCodeAt(j))) j++;
      } else {
        while (j < n && (isDigitCode(s.charCodeAt(j)) || s.charCodeAt(j) === 95)) j++;
        if (j < n && s[j] === "." && j + 1 < n && isDigitCode(s.charCodeAt(j + 1))) {
          j += 2;
          while (j < n && (isDigitCode(s.charCodeAt(j)) || s.charCodeAt(j) === 95)) j++;
        }
      }
      push("number", s.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers: keywords, functions (followed by `(`), PascalCase types
    if (isIdentStartCode(code)) {
      let j = i + 1;
      while (j < n && isIdentPartCode(s.charCodeAt(j))) j++;
      const word = s.slice(i, j);
      const nextCh = s[j];
      let kind = "plain";
      if (KEYWORDS.has(word)) {
        kind = (word === "true" || word === "false" || word === "null" || word === "undefined" || word === "nil" || word === "None" || word === "True" || word === "False")
          ? "boolean"
          : "keyword";
      } else if (nextCh === "(") {
        kind = "function";
      } else if (code >= 65 && code <= 90 && word.length > 1) {
        let allUpper = true;
        for (let k = 1; k < word.length; k++) {
          const kc = word.charCodeAt(k);
          if (!(kc >= 65 && kc <= 90) && !isDigitCode(kc) && kc !== 95) { allUpper = false; break; }
        }
        kind = allUpper ? "constant" : "type";
      }
      push(kind, word);
      i = j;
      continue;
    }

    push("plain", ch);
    i++;
  }

  return tokens;
}

// Trims excess common leading indentation per hunk (separated by `kind === "gap"`) so deeply
// nested C#/Java/JSX code doesn't start 120px to the right while preserving 100% of relative nesting.
export function dedentDiffRows(rows, style = "unified") {
  if (!Array.isArray(rows) || !rows.length) return rows || [];
  const normTabs = s => String(s ?? "").replace(/\t/g, "  ");
  const leadingSpaces = s => {
    const m = /^ +/.exec(s);
    return m ? m[0].length : 0;
  };
  const trimBy = (s, n) => {
    const t = normTabs(s);
    if (!n || !t.trim()) return t;
    let cut = 0;
    while (cut < n && t[cut] === " ") cut++;
    return t.slice(cut);
  };

  // Split into hunks separated by gap/note rows
  const out = [];
  let hunk = [];
  const flush = () => {
    if (!hunk.length) return;
    let minIndent = Infinity;
    for (const r of hunk) {
      if (style === "split") {
        for (const side of [r.left, r.right]) {
          if (side && side.text && side.text.trim()) {
            const ind = leadingSpaces(normTabs(side.text));
            if (ind < minIndent) minIndent = ind;
          }
        }
      } else if (r.text && r.text.trim()) {
        const ind = leadingSpaces(normTabs(r.text));
        if (ind < minIndent) minIndent = ind;
      }
    }
    // Keep at most 2 spaces of base margin when the whole hunk is deeply indented (>= 4 spaces).
    const strip = Number.isFinite(minIndent) && minIndent >= 4 ? minIndent - 2 : 0;
    for (const r of hunk) {
      if (style === "split") {
        out.push({
          ...r,
          left: r.left ? { ...r.left, text: trimBy(r.left.text, strip) } : r.left,
          right: r.right ? { ...r.right, text: trimBy(r.right.text, strip) } : r.right,
        });
      } else {
        out.push({ ...r, text: trimBy(r.text, strip) });
      }
    }
    hunk = [];
  };

  for (const r of rows) {
    if (r.kind === "gap" || r.kind === "note") {
      flush();
      out.push(r);
    } else {
      hunk.push(r);
    }
  }
  flush();
  return out;
}
