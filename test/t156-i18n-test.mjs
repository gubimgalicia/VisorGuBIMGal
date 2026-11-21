// T-156 (C23): i18n scaffolding tests and TSX literal-text guard.
// Ensures every .tsx file under src/ui and src/App.tsx routes visible JSX text and
// title/placeholder/aria-label/alt attributes through t(), except explicitly justified allow-listed
// literals (brand names, sample asset names, units, IFC class names).
// Usage: node --experimental-strip-types test/t156-i18n-test.mjs
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// Resolve extensionless relative imports and directory imports (such as ../i18n) under Node ESM.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && context.parentURL) {
        const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
        for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
          if (existsSync(candidate)) {
            return nextResolve(pathToFileURL(candidate).href, context);
          }
        }
      }
      throw err;
    }
  }
});

const {
  DEFAULT_LOCALE,
  es,
  formatBytes,
  formatDate,
  formatLength,
  formatNumber,
  getIntlLocale,
  getLocale,
  setLocale,
  t
} = await import('../src/ui/i18n/index.ts');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAS_LETTER = /\p{L}/u;
const CHECKED_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt']);

/**
 * Only literals that must never be translated across locales belong here, each with a reason.
 * Checked against trimmed literal text before failing.
 */
export const I18N_ALLOW_LIST = new Map([
  ['VisorGuBIMGal', 'Application brand name (Header)'],
  ['SimpleWall', 'Bundled IFC sample filename identifier (Header)'],
  ['ManySimpleWalls', 'Bundled IFC sample filename identifier (Header)']
]);

function isAllowedLiteral(text) {
  const trimmed = text.trim();
  if (!HAS_LETTER.test(trimmed)) return true;
  if (I18N_ALLOW_LIST.has(trimmed)) return true;
  // Standard SI/imperial unit tokens and IFC schema class names (e.g. IfcWall) never translate.
  if (/^(m|m²|m³|mm|cm|km|B|KB|MB|GB|FPS|ms|s)$/.test(trimmed)) return true;
  if (/^Ifc[A-Z][A-Za-z0-9]*$/.test(trimmed)) return true;
  return false;
}

function collectTsxFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...collectTsxFiles(full));
    else if (full.endsWith('.tsx')) files.push(full);
  }
  return files;
}

function isTranslateCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 't'
  );
}

/** Collects string/template literals in value positions (not comparison/index operands) outside `t(...)`. */
function findUntranslatedLiteralsInExpr(node, sourceFile, out) {
  if (!node) return;
  if (isTranslateCall(node)) {
    // Allow key (arg 0); still check any additional parameter expressions for hardcoded text.
    for (let i = 1; i < node.arguments.length; i++) {
      findUntranslatedLiteralsInExpr(node.arguments[i], sourceFile, out);
    }
    return;
  }
  if (ts.isParenthesizedExpression(node)) {
    findUntranslatedLiteralsInExpr(node.expression, sourceFile, out);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    findUntranslatedLiteralsInExpr(node.whenTrue, sourceFile, out);
    findUntranslatedLiteralsInExpr(node.whenFalse, sourceFile, out);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      findUntranslatedLiteralsInExpr(node.right, sourceFile, out);
      return;
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      findUntranslatedLiteralsInExpr(node.left, sourceFile, out);
      findUntranslatedLiteralsInExpr(node.right, sourceFile, out);
      return;
    }
  }
  if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
    return;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (!isAllowedLiteral(node.text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      out.push({ line: line + 1, text: node.text });
    }
    return;
  }
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
    if (parts.some((p) => !isAllowedLiteral(p))) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      out.push({ line: line + 1, text: node.getText(sourceFile) });
    }
    for (const span of node.templateSpans) {
      findUntranslatedLiteralsInExpr(span.expression, sourceFile, out);
    }
    return;
  }
  // Do not descend into nested JSX elements from an expression; the outer AST walk handles them.
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    return;
  }
  ts.forEachChild(node, (child) => findUntranslatedLiteralsInExpr(child, sourceFile, out));
}

export function scanTsxFile(filePath, content = readFileSync(filePath, 'utf8')) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [];
  const rel = path.relative(REPO, filePath).replace(/\\/g, '/');

  function visit(node) {
    if (ts.isJsxText(node)) {
      const raw = node.getText(sourceFile);
      if (!isAllowedLiteral(raw)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({ file: rel, line: line + 1, kind: 'jsx-text', text: raw.trim() });
      }
    } else if (ts.isJsxAttribute(node)) {
      const attrName = node.name.getText(sourceFile);
      if (CHECKED_ATTRS.has(attrName) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          if (!isAllowedLiteral(node.initializer.text)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.initializer.getStart(sourceFile));
            violations.push({
              file: rel,
              line: line + 1,
              kind: `attr:${attrName}`,
              text: node.initializer.text
            });
          }
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          const found = [];
          findUntranslatedLiteralsInExpr(node.initializer.expression, sourceFile, found);
          for (const item of found) {
            violations.push({ file: rel, line: item.line, kind: `attr:${attrName}`, text: item.text });
          }
        }
      }
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      const found = [];
      findUntranslatedLiteralsInExpr(node.expression, sourceFile, found);
      for (const item of found) {
        violations.push({ file: rel, line: item.line, kind: 'jsx-expr', text: item.text });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

check('all .tsx files under src/ui and src/App.tsx have no visible text outside t()', () => {
  const targets = [path.join(REPO, 'src/App.tsx'), ...collectTsxFiles(path.join(REPO, 'src/ui'))];
  assert.ok(targets.length >= 18, `expected >= 18 .tsx files, got ${targets.length}`);
  const violations = targets.flatMap((file) => scanTsxFile(file));
  assert.deepEqual(
    violations,
    [],
    `Found visible text outside t():\n${violations.map((v) => `  ${v.file}:${v.line} [${v.kind}] ${JSON.stringify(v.text)}`).join('\n')}`
  );
});

check('scanner rejects deliberate literals in JSX text, JSX expressions, and checked attributes', () => {
  const sample = `
    export const Dummy = () => (
      <div title="Título literal" aria-label={\`Etiqueta \${1}\`}>
        <span>Texto literal</span>
        <span>{'Texto en expresión'}</span>
        <span>VisorGuBIMGal</span>
      </div>
    );
  `;
  const found = scanTsxFile(path.join(REPO, 'src/Dummy.tsx'), sample);
  assert.equal(found.length, 4, JSON.stringify(found));
  assert.deepEqual(
    found.map((v) => v.kind),
    ['attr:title', 'attr:aria-label', 'jsx-text', 'jsx-expr']
  );
});

check('i18n catalogue leaves are valid non-empty strings or { one, other } plural entries', () => {
  let count = 0;
  function walk(node, prefix = '') {
    for (const [k, v] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') {
        assert.ok(v.length > 0, `empty string at ${key}`);
        count++;
      } else if (v && typeof v === 'object' && 'one' in v && 'other' in v) {
        assert.ok(typeof v.one === 'string' && v.one.length > 0, `empty plural.one at ${key}`);
        assert.ok(typeof v.other === 'string' && v.other.length > 0, `empty plural.other at ${key}`);
        count++;
      } else {
        assert.ok(v && typeof v === 'object', `invalid leaf at ${key}`);
        walk(v, key);
      }
    }
  }
  walk(es);
  assert.ok(count >= 200, `expected >= 200 catalogue entries, got ${count}`);
});

check('t() translates keys, interpolates params, and selects Spanish plurals via Intl.PluralRules', () => {
  assert.equal(getLocale(), DEFAULT_LOCALE);
  assert.equal(getIntlLocale(), 'es-ES');
  assert.equal(t('header.openIfc'), 'Abrir IFC');
  assert.equal(t('app.statusModelLoaded', { fileName: 'Muro.ifc', count: 1 }), 'Muro.ifc cargado con 1 malla.');
  assert.equal(t('app.statusModelLoaded', { fileName: 'Muro.ifc', count: 4 }), 'Muro.ifc cargado con 4 mallas.');
  assert.equal(t('diagnostics.severityWarning', { count: 1 }), '1 aviso');
  assert.equal(t('diagnostics.severityWarning', { count: 3 }), '3 avisos');
  assert.equal(t('app.statusCsvExported', { filename: 'a.csv', count: 1 }), 'Mediciones exportadas a a.csv (1 elemento).');
  assert.equal(t('app.statusCsvExported', { filename: 'a.csv', count: 5 }), 'Mediciones exportadas a a.csv (5 elementos).');
});

check('Intl formatters default to es-ES and preserve expected number, date, and length formats', () => {
  assert.equal(formatNumber(1.5, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), '1,5');
  assert.equal(formatLength(1.2, 2), '1.20 m');
  assert.equal(formatLength(1.2, 2, { decimalStyle: 'locale' }), '1,20 m');
  assert.equal(formatBytes(39833), '38.9 KB');
  const formattedDate = formatDate('2026-11-20T00:00:00Z', { timeZone: 'UTC' });
  assert.match(formattedDate, /20\/11\/2026/);
});

check('setLocale updates document.documentElement.lang and document.title', () => {
  const prevDoc = globalThis.document;
  globalThis.document = { documentElement: { lang: '' }, title: '' };
  try {
    setLocale('es');
    assert.equal(globalThis.document.documentElement.lang, 'es');
    assert.equal(globalThis.document.title, 'VisorGuBIMGal — Visor BIM/GIS Web');
  } finally {
    globalThis.document = prevDoc;
  }
});

console.log(`\nt156-i18n-test: ${passed}/${passed} pass`);
