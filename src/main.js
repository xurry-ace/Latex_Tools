import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';
import { toggleComment } from '@codemirror/commands';
import { gotoLine } from '@codemirror/search';
import { linter, setDiagnostics, lintGutter } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './style.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// 与服务端 server/index.mjs 同名常量保持一致（见 docs/round-2026-11-12-contract.md §7）。
// 前端超时留出 10s 余量，避免服务端还在收尾时前端先断开。
const COMPILE_TIMEOUT_MS = 180_000;
const SNIPPET_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;

const state = {
  projectRoot: null,
  files: [],
  activeFile: null,
  rootFile: null,
  mtimeMs: null,
  dirty: false,
  compiling: false,
  pdfUrl: null,
  result: null,
  tab: 'preview',
  sidebarMode: 'files',
  sidebarCollapsed: false,
  outlineMode: (() => { try { return localStorage.getItem('yantai:outlineMode') === 'file' ? 'file' : 'project'; } catch { return 'project'; } })(),
  outline: [],
  projectOutline: [],
  wordCounts: {},
  references: [],
  labels: [],
  refQuery: '',
  logFilter: 'all',
  mathCat: 'common',
  treeFilter: '',
  collapsedFolders: new Set(),
  fullCompileBackup: null,
  editorFontSize: (() => {
    try {
      const saved = Number(localStorage.getItem('yantai:fontSize'));
      return saved >= 12 && saved <= 20 ? saved : 14;
    } catch { return 14; }
  })(),
  autoSave: (() => { try { return localStorage.getItem('yantai:autoSave') === '1'; } catch { return false; } })(),
  autoCompile: (() => { try { return localStorage.getItem('yantai:autoCompile') === '1'; } catch { return false; } })(),
  pdfScrollMode: (() => { try { return localStorage.getItem('yantai:pdfMode') === 'single' ? 'single' : 'continuous'; } catch { return 'continuous'; } })(),
  pdfFitMode: (() => { try { return localStorage.getItem('yantai:pdfFit') === 'page' ? 'page' : 'width'; } catch { return 'width'; } })(),
  searchCaseSensitive: false,
  searchRegex: false,
  searchQuery: '',
  pdfFingerprint: null,
  compileToken: null,
  pdfStale: false
};

// Last compile's messages per file, so markers survive switching between chapter files.
const fileDiagnostics = new Map();

const commands = [
  '\\chapter{}', '\\section{}', '\\subsection{}', '\\subsubsection{}', '\\paragraph{}',
  '\\textbf{}', '\\textit{}', '\\emph{}', '\\underline{}', '\\texttt{}',
  '\\cite{}', '\\citet{}', '\\citep{}', '\\ref{}', '\\eqref{}', '\\autoref{}', '\\pageref{}', '\\label{}', '\\footnote{}',
  '\\begin{}', '\\end{}', '\\item', '\\includegraphics{}', '\\caption{}', '\\centering',
  '\\frac{}{}', '\\sqrt{}', '\\sum_{}^{}', '\\int_{}^{}', '\\prod_{}^{}', '\\lim_{}',
  '\\hat{}', '\\bar{}', '\\tilde{}', '\\vec{}', '\\dot{}',
  '\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\varepsilon', '\\theta', '\\lambda', '\\mu', '\\pi', '\\sigma', '\\phi', '\\varphi', '\\omega',
  '\\Delta', '\\Gamma', '\\Lambda', '\\Omega', '\\Phi', '\\Pi', '\\Sigma', '\\Theta',
  '\\partial', '\\nabla', '\\infty', '\\approx', '\\neq', '\\leq', '\\geq', '\\times', '\\cdot', '\\pm',
  '\\in', '\\notin', '\\subset', '\\subseteq', '\\cup', '\\cap', '\\forall', '\\exists', '\\to', '\\Rightarrow', '\\Leftrightarrow',
  '\\mathbb{}', '\\mathbf{}', '\\mathcal{}', '\\mathrm{}', '\\text{}',
  '\\toprule', '\\midrule', '\\bottomrule', '\\cmidrule{}', '\\multicolumn{}{}{}',
  '\\input{}', '\\include{}', '\\usepackage{}', '\\newcommand{}{}', '\\url{}', '\\href{}{}'
];

const mathCategories = {
  common: [
    { tex: '\\frac{a}{b}', label: 'a/b', title: '分式' },
    { tex: '\\sqrt{x}', label: '√x', title: '平方根' },
    { tex: 'x^{2}', label: 'x²', title: '上标' },
    { tex: 'x_{i}', label: 'xᵢ', title: '下标' },
    { tex: '\\sum_{i=1}^{n}', label: '∑', title: '求和' },
    { tex: '\\prod_{i=1}^{n}', label: '∏', title: '连乘' },
    { tex: '\\int_{a}^{b}', label: '∫', title: '定积分' },
    { tex: '\\lim_{n \\to \\infty}', label: 'lim', title: '极限' },
    { tex: '\\partial', label: '∂', title: '偏导' },
    { tex: '\\nabla', label: '∇', title: '梯度算子' },
    { tex: '\\infty', label: '∞', title: '无穷' },
    { tex: '\\hat{x}', label: 'x̂', title: '估计量 hat' },
    { tex: '\\bar{x}', label: 'x̄', title: '均值 bar' },
    { tex: '\\tilde{x}', label: 'x̃', title: 'tilde' },
    { tex: '\\vec{x}', label: 'x⃗', title: '向量箭头' },
    { tex: '\\mathbf{x}', label: '𝐱', title: '向量/矩阵粗体' },
    { tex: '\\mathbb{R}', label: 'ℝ', title: '实数集黑板粗体' },
    { tex: '\\mathcal{L}', label: 'ℒ', title: '花体（损失函数等）' }
  ],
  greek: [
    { tex: '\\alpha', label: 'α', title: 'alpha' },
    { tex: '\\beta', label: 'β', title: 'beta' },
    { tex: '\\gamma', label: 'γ', title: 'gamma' },
    { tex: '\\delta', label: 'δ', title: 'delta' },
    { tex: '\\epsilon', label: 'ϵ', title: 'epsilon' },
    { tex: '\\varepsilon', label: 'ε', title: 'varepsilon' },
    { tex: '\\zeta', label: 'ζ', title: 'zeta' },
    { tex: '\\eta', label: 'η', title: 'eta' },
    { tex: '\\theta', label: 'θ', title: 'theta' },
    { tex: '\\kappa', label: 'κ', title: 'kappa' },
    { tex: '\\lambda', label: 'λ', title: 'lambda' },
    { tex: '\\mu', label: 'μ', title: 'mu' },
    { tex: '\\nu', label: 'ν', title: 'nu' },
    { tex: '\\xi', label: 'ξ', title: 'xi' },
    { tex: '\\pi', label: 'π', title: 'pi' },
    { tex: '\\rho', label: 'ρ', title: 'rho' },
    { tex: '\\sigma', label: 'σ', title: 'sigma' },
    { tex: '\\tau', label: 'τ', title: 'tau' },
    { tex: '\\phi', label: 'ϕ', title: 'phi' },
    { tex: '\\varphi', label: 'φ', title: 'varphi' },
    { tex: '\\chi', label: 'χ', title: 'chi' },
    { tex: '\\psi', label: 'ψ', title: 'psi' },
    { tex: '\\omega', label: 'ω', title: 'omega' },
    { tex: '\\Delta', label: 'Δ', title: 'Delta' },
    { tex: '\\Gamma', label: 'Γ', title: 'Gamma' },
    { tex: '\\Lambda', label: 'Λ', title: 'Lambda' },
    { tex: '\\Sigma', label: 'Σ', title: 'Sigma' },
    { tex: '\\Theta', label: 'Θ', title: 'Theta' },
    { tex: '\\Omega', label: 'Ω', title: 'Omega' }
  ],
  matrix: [
    { tex: '\\begin{bmatrix}\n  a & b \\\\\n  c & d\n\\end{bmatrix}', label: '[矩阵]', title: '方括号矩阵 bmatrix' },
    { tex: '\\begin{pmatrix}\n  a & b \\\\\n  c & d\n\\end{pmatrix}', label: '(矩阵)', title: '圆括号矩阵 pmatrix' },
    { tex: '\\begin{vmatrix}\n  a & b \\\\\n  c & d\n\\end{vmatrix}', label: '|行列式|', title: '行列式 vmatrix' },
    { tex: '\\begin{cases}\n  x, & x \\geq 0 \\\\\n  0, & x < 0\n\\end{cases}', label: '{分段', title: '分段函数 cases' },
    { tex: '\\left( \\frac{a}{b} \\right)', label: '(自适应)', title: '自适应圆括号' },
    { tex: '\\left\\| x \\right\\|_{2}', label: '‖x‖₂', title: '范数' },
    { tex: '\\binom{n}{k}', label: 'C(n,k)', title: '组合数 binom' },
    { tex: '\\underbrace{a + b}_{\\text{说明}}', label: '下括注', title: '下花括号说明' }
  ],
  relation: [
    { tex: '\\leq', label: '≤', title: '小于等于' },
    { tex: '\\geq', label: '≥', title: '大于等于' },
    { tex: '\\neq', label: '≠', title: '不等于' },
    { tex: '\\approx', label: '≈', title: '约等于' },
    { tex: '\\equiv', label: '≡', title: '恒等于' },
    { tex: '\\sim', label: '∼', title: '服从/相似' },
    { tex: '\\propto', label: '∝', title: '正比于' },
    { tex: '\\pm', label: '±', title: '正负号' },
    { tex: '\\times', label: '×', title: '乘号' },
    { tex: '\\cdot', label: '·', title: '点乘' },
    { tex: '\\in', label: '∈', title: '属于' },
    { tex: '\\notin', label: '∉', title: '不属于' },
    { tex: '\\subseteq', label: '⊆', title: '子集' },
    { tex: '\\cup', label: '∪', title: '并集' },
    { tex: '\\cap', label: '∩', title: '交集' },
    { tex: '\\forall', label: '∀', title: '任意' },
    { tex: '\\exists', label: '∃', title: '存在' },
    { tex: '\\to', label: '→', title: '趋近/映射' },
    { tex: '\\Rightarrow', label: '⇒', title: '推出' },
    { tex: '\\Leftrightarrow', label: '⇔', title: '等价于' }
  ]
};

const latexLanguage = StreamLanguage.define({
  startState: () => ({ math: false }),
  token(stream, mode) {
    if (stream.match(/^%.*$/)) return 'comment';
    if (stream.match(/^\\(?:[A-Za-z@]+|.)/)) return 'keyword';
    if (stream.match(/^[{}\[\]]/)) return 'bracket';
    if (stream.match(/^\${1,2}/)) { mode.math = !mode.math; return 'string'; }
    if (stream.match(/^[&_^]/)) return 'operator';
    if (stream.match(/^\d+(?:\.\d+)?/)) return 'number';
    stream.next();
    return mode.math ? 'string' : null;
  },
  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['(', '[', '{', '$'] }
  }
});

const chinesePhrases = EditorState.phrases.of({
  Find: '当前文件查找…',
  Replace: '替换为…',
  next: '下一个',
  previous: '上一个',
  all: '全选',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '整词',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'Go to line': '跳转到行号',
  go: '跳转'
});

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size, 14px)' },
  '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.75', overflow: 'auto' },
  '.cm-content': { padding: '22px 18px 64px' },
  '.cm-gutters': { backgroundColor: '#fbfaf6', borderRight: '1px solid #e7e4dc', color: '#aaa9a1' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#e7f3ee88' },
  '.cm-cursor': { borderLeftColor: '#145b50' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#c9e7db !important' }
});

const latexColors = HighlightStyle.define([
  { tag: tags.keyword, color: '#0f7564', fontWeight: '600' },
  { tag: tags.comment, color: '#9c9a91', fontStyle: 'italic' },
  { tag: tags.string, color: '#a05c39' },
  { tag: tags.bracket, color: '#597e93' },
  { tag: tags.operator, color: '#9060a2' },
  { tag: tags.number, color: '#a05c39' }
]);

function populateFileDiagnostics(diagnostics = []) {
  fileDiagnostics.clear();
  for (const item of diagnostics) {
    if (!item.file || !item.line) continue;
    const list = fileDiagnostics.get(item.file) || [];
    list.push(item);
    fileDiagnostics.set(item.file, list);
  }
  refreshEditorDiagnostics();
  renderTree();
}

// Compile messages are kept per file; only the file on screen gets markers.
function currentFileDiagnostics() {
  if (!state.activeFile) return [];
  const items = fileDiagnostics.get(state.activeFile);
  if (!items?.length) return [];
  const doc = editor.state.doc;
  if (!doc.lines) return [];
  return items.map(item => {
    const row = doc.line(Math.max(1, Math.min(item.line || 1, doc.lines)));
    const message = item.hint ? `${item.message}\n💡 ${item.hint}` : item.message;
    return { from: row.from, to: row.to, severity: item.kind === 'error' ? 'error' : 'warning', message };
  });
}

function refreshEditorDiagnostics() {
  if (!editor) return;
  editor.dispatch(setDiagnostics(editor.state, currentFileDiagnostics()));
}

async function goToNextDiagnostic() {
  const localItems = (fileDiagnostics.get(state.activeFile) || []).filter(item => item.line).sort((a, b) => a.line - b.line);
  const allLocated = (state.result?.diagnostics || []).filter(item => item.file && item.line && state.files.some(f => f.path === item.file));
  if (!localItems.length && !allLocated.length) {
    notify('当前没有可跳转的编译错误或提示，可先按 ⌘↵ 编译', 'info');
    return;
  }
  if (localItems.length) {
    const cursorLine = editor.state.doc.lineAt(editor.state.selection.main.head).number;
    const nextInFile = localItems.find(item => item.line > cursorLine);
    if (nextInFile) {
      jumpToLine(nextInFile.line);
      notify(`${nextInFile.kind === 'error' ? '错误' : '提示'} · 第 ${nextInFile.line} 行 · ${nextInFile.message}`);
      return;
    }
    const otherFileItem = allLocated.find(item => item.file !== state.activeFile);
    if (otherFileItem) {
      await openFile(otherFileItem.file, otherFileItem.line);
      notify(`${otherFileItem.kind === 'error' ? '错误' : '提示'} · ${otherFileItem.file}:${otherFileItem.line} · ${otherFileItem.message}`);
      return;
    }
    jumpToLine(localItems[0].line);
    notify(`${localItems[0].kind === 'error' ? '错误' : '提示'} · 第 ${localItems[0].line} 行 · ${localItems[0].message}`);
    return;
  }
  const target = allLocated[0];
  await openFile(target.file, target.line);
  notify(`${target.kind === 'error' ? '错误' : '提示'} · ${target.file}:${target.line} · ${target.message}`);
}

async function buildSnippetPreamble(documentText) {
  const beginDocMatch = documentText.match(/\\begin\{document\}/);
  if (beginDocMatch) {
    return documentText.slice(0, beginDocMatch.index).replace(/\\includeonly\{[^}]*\}/g, '');
  }
  if (state.rootFile && state.rootFile !== state.activeFile) {
    try {
      const rootData = await request(`/api/file?path=${encodeURIComponent(state.rootFile)}`);
      const rootBegin = rootData.content.match(/\\begin\{document\}/);
      if (rootBegin) {
        return rootData.content.slice(0, rootBegin.index).replace(/\\includeonly\{[^}]*\}/g, '');
      }
    } catch {}
  }
  return '\\documentclass[UTF8,a4paper,12pt]{ctexart}\n\\usepackage{amsmath,amssymb,graphicx,booktabs}\n';
}

async function compileSelectedText() {
  if (!state.activeFile?.endsWith('.tex')) { notify('请先打开 .tex 文件', 'error'); return; }
  const range = editor.state.selection.main;
  if (range.empty) { notify('先选中一段公式、表格或段落，再按 ⌘L 极速预览选段', 'info'); return; }
  const fromLine = editor.state.doc.lineAt(range.from).number;
  const toLine = editor.state.doc.lineAt(range.to).number;
  const documentText = editor.state.doc.toString();
  const body = documentText.slice(range.from, range.to);
  if (!body.trim()) { notify('选中的内容为空', 'error'); return; }
  const preamble = (await buildSnippetPreamble(documentText)).trimEnd();
  const source = `${preamble}\n\\pagestyle{empty}\n\\begin{document}\n${body}\n\\end{document}\n`;
  const bodyStart = preamble.split('\n').length + 4;
  showTab('preview');
  compileSnippet({ source, editorFile: state.activeFile, fromLine, toLine, bodyStart });
}

function toggleCommentKeepingSelection() {
  const range = editor.state.selection.main;
  if (range.empty) {
    toggleComment({ state: editor.state, dispatch: transaction => editor.dispatch(transaction) });
    return;
  }
  // With text selected, comment only the lines that are fully inside the selection.
  const { doc } = editor.state;
  const first = doc.line(doc.lineAt(range.from).number + (range.from > doc.lineAt(range.from).from ? 1 : 0)).from;
  const to = doc.lineAt(range.to).from;
  if (to <= first) {
    toggleComment({ state: editor.state, dispatch: transaction => editor.dispatch(transaction) });
    return;
  }
  const block = doc.sliceString(first, to);
  const lines = block.split('\n');
  const commented = lines.every(line => /^\s*%/.test(line));
  const next = lines.map(line => {
    if (commented) return line.replace(/^(\s*)%/, '$1');
    return line.replace(/^(\s*)/, '$1%');
  }).join('\n');
  editor.dispatch({
    changes: { from: first, to, insert: next },
    selection: { anchor: first, head: first + next.length },
    scrollIntoView: true
  });
}

function applyCommandCompletion(view, completion, from, to) {
  const text = completion.applyText || completion.label;
  const bracePos = text.indexOf('{}');
  const cursor = bracePos >= 0 ? from + bracePos + 1 : from + text.length;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: cursor },
    scrollIntoView: true
  });
}

function latexCompletions(context) {
  const argMatch = context.matchBefore(/\\(cite[a-zA-Z]*|ref|eqref|autoref|pageref|input|include|includegraphics(?:\[[^\]]*\])?)\{([^}]*)$/);
  if (argMatch) {
    const cmd = argMatch.text.match(/^\\([a-zA-Z]+)/)?.[1] || '';
    const openBraceOffset = argMatch.text.lastIndexOf('{') + 1;
    const contentStart = argMatch.from + openBraceOffset;
    const currentArg = argMatch.text.slice(openBraceOffset);
    const commaOffset = currentArg.lastIndexOf(',');
    const from = commaOffset >= 0 ? contentStart + commaOffset + 1 : contentStart;
    if (cmd.startsWith('cite')) {
      return {
        from,
        options: state.references.map(ref => ({
          label: ref.key,
          type: 'variable',
          detail: ref.title || ref.type,
          info: [ref.author, ref.year, ref.file].filter(Boolean).join(' · ')
        })),
        validFor: /^[^,}]*$/
      };
    }
    if (['ref', 'eqref', 'autoref', 'pageref'].includes(cmd)) {
      return {
        from,
        options: state.labels.map(item => ({
          label: item.key,
          type: 'variable',
          detail: item.context || item.file
        })),
        validFor: /^[^}]*$/
      };
    }
    if (cmd === 'input' || cmd === 'include') {
      const texFiles = state.files.filter(f => f.path.endsWith('.tex') && f.path !== state.activeFile);
      return {
        from,
        options: texFiles.map(f => ({
          label: f.path.replace(/\.tex$/, ''),
          type: 'text',
          detail: f.path
        })),
        validFor: /^[^}]*$/
      };
    }
    if (cmd === 'includegraphics') {
      const images = state.files.filter(f => f.type === 'image');
      return {
        from,
        options: images.map(f => ({
          label: f.path,
          type: 'text',
          detail: '图片'
        })),
        validFor: /^[^}]*$/
      };
    }
  }

  const envMatch = context.matchBefore(/\\(begin|end)\{([a-zA-Z*]*)$/);
  if (envMatch) {
    const isBegin = envMatch.text.startsWith('\\begin{');
    const from = envMatch.from + envMatch.text.indexOf('{') + 1;
    const envs = [
      'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'split', 'cases',
      'pmatrix', 'bmatrix', 'vmatrix', 'itemize', 'enumerate', 'figure', 'figure*',
      'table', 'table*', 'tabular', 'abstract', 'theorem', 'lemma', 'definition',
      'corollary', 'proof', 'remark', 'quote', 'verbatim', 'minipage'
    ];
    return {
      from,
      options: envs.map(env => ({
        label: env,
        type: 'keyword',
        detail: isBegin ? '插入环境' : '闭合环境',
        apply: (view, _completion, start, end) => {
          const after = view.state.doc.sliceString(end, end + 1);
          const closeBrace = after === '}' ? '' : '}';
          const closeOffset = after === '}' ? 1 : 0;
          if (isBegin) {
            const snippet = `${env}${closeBrace}\n  \n\\end{${env}}`;
            const cursor = start + env.length + closeBrace.length + 3;
            view.dispatch({ changes: { from: start, to: end + closeOffset, insert: snippet }, selection: { anchor: cursor }, scrollIntoView: true });
          } else {
            const snippet = `${env}${closeBrace}`;
            view.dispatch({ changes: { from: start, to: end + closeOffset, insert: snippet }, selection: { anchor: start + snippet.length }, scrollIntoView: true });
          }
        }
      })),
      validFor: /^[a-zA-Z*]*$/
    };
  }

  const word = context.matchBefore(/\\[A-Za-z]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return {
    from: word.from,
    options: commands.map(command => ({
      label: command,
      type: 'keyword',
      apply: (view, completion, from, to) => applyCommandCompletion(view, completion, from, to)
    })),
    validFor: /^\\[A-Za-z]*$/
  };
}

let outlineTimer = null;
let autoSaveTimer = null;
let lastOutlineCursorLine = -1;
let outlineHighlightFrame = 0;
let outlineRenderFrame = 0;

// 编辑后需要跑全量正则的活（大纲解析、全篇字数）统一走这个防抖；输入事件本身一律不跑正则。
// 每步单独兜底：任何一步抛异常都不能连锁吞掉后面的字数刷新、自动保存和自动编译。
function runDeferredEditorUpdates() {
  try { updateOutline(); } catch (error) { console.warn('[砚台] 大纲刷新失败', error); }
  try { renderWordCount(); } catch (error) { console.warn('[砚台] 字数统计刷新失败', error); }
}

function scheduleEditorUpdates() {
  statsCache.valid = false;
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(runDeferredEditorUpdates, 120);
  if (state.autoSave && state.dirty && state.activeFile) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      if (state.dirty && state.activeFile && !state.compiling) {
        const saved = await saveFile({ silent: true });
        // 自动保存触发的编译：撞到「已有编译任务」直接跳过，不弹提示
        if (saved && state.autoCompile && !state.compiling) compile({ silentSuccess: true, silent: true });
      }
    }, 1500);
  }
}

const extensions = [
  basicSetup,
  chinesePhrases,
  latexLanguage,
  syntaxHighlighting(latexColors),
  editorTheme,
  EditorView.lineWrapping,
  autocompletion({ override: [latexCompletions] }),
  linter(() => currentFileDiagnostics(), { delay: 400 }),
  lintGutter(),
  keymap.of([
    {
      key: 'Mod-s',
      run: () => {
        saveFile().then(ok => {
          if (ok && state.autoCompile && !state.compiling) compile({ silentSuccess: true });
        });
        return true;
      }
    },
    { key: 'Mod-Enter', run: () => { compile(); return true; } },
    { key: 'Mod-l', run: () => { compileSelectedText(); return true; } },
    { key: 'Mod-j', run: () => { syncCursorToPdf(); return true; } },
    { key: 'Mod-p', run: () => { openQuickSwitcher(); return true; } },
    { key: 'Mod-Shift-e', run: () => { goToNextDiagnostic(); return true; } },
    { key: 'Mod-\\', run: () => { toggleSidebar(); return true; } },
    { key: 'Mod-b', run: () => { quickSnippet('bold'); return true; } },
    { key: 'Mod-i', run: () => { quickSnippet('italic'); return true; } },
    { key: 'Mod-m', run: () => { quickSnippet('inlineMath'); return true; } },
    { key: 'Mod-/', run: () => { toggleCommentKeepingSelection(); return true; } }
  ]),
  EditorView.domEventHandlers({
    dblclick(event, view) {
      // Plain double-click keeps CodeMirror's default word selection; ⌘ double-click compiles it.
      if (!event.metaKey && !event.ctrlKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      view.dispatch({ selection: { anchor: line.from, head: line.to } });
      compileSelectedText();
      event.preventDefault();
      return true;
    },
    paste(event) {
      if (!state.projectRoot || !state.activeFile?.endsWith('.tex')) return false;
      const items = Array.from(event.clipboardData?.items || []);
      const imageItem = items.find(item => item.type.startsWith('image/'));
      if (!imageItem) return false;
      const file = imageItem.getAsFile();
      if (!file) return false;
      event.preventDefault();
      const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const namedFile = new File([file], `paste-${Date.now()}.${ext}`, { type: file.type });
      importPastedImage(namedFile);
      return true;
    },
    drop(event) {
      if (!state.projectRoot || !state.activeFile?.endsWith('.tex')) return false;
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return false;
      const imageFile = files.find(file => /\.(png|jpe?g|pdf|eps|svg)$/i.test(file.name));
      // 拖进来的是别的文件（比如 .zip）：也要吃掉默认行为，否则浏览器会往光标处插一段文件路径文本
      event.preventDefault();
      if (!imageFile) {
        notify('只支持拖入 .png/.jpg/.jpeg/.pdf/.eps/.svg 图片，其他文件已忽略', 'info');
        return true;
      }
      importPastedImage(imageFile);
      return true;
    }
  }),
  EditorView.updateListener.of(update => {
    if (update.docChanged && state.activeFile) {
      state.dirty = true;
      // 输入路径上只做 O(行数) 的行数/按钮刷新 + O(1) 缓存失效，全量正则交给 scheduleEditorUpdates
      renderFileStatus();
      scheduleEditorUpdates();
    }
    if (update.selectionSet) {
      renderCursorPosition();
      // 选区随输入一起变短时字数条要跟着变；纯光标移动只换大纲高亮，绝不重算全文字数
      if (update.docChanged) renderWordCount();
      else highlightOutlineAtCursor();
    }
  })
];

document.querySelector('#app').innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <button class="sidebar-toggle-btn" id="toggleSidebar" title="折叠/展开左侧边栏 (⌘\\)" aria-label="折叠或展开左侧边栏" aria-expanded="true">☰</button>
      <div class="brand"><span class="brand-mark">砚</span><span><strong>砚台</strong><small>LaTeX 写作台</small></span></div>
      <div class="header-project" id="headerProjectTrigger" title="点击切换或打开其他项目"><span class="header-caption">当前项目</span><span id="projectName">尚未打开项目</span></div>
      <div class="header-actions">
        <div class="topbar-overflow" id="topbarOverflow" data-overflow="start">
          <span class="topbar-menu-caption">写作偏好</span>
          <label class="autosave-toggle" title="修改停顿后自动保存到本机文件"><input type="checkbox" id="autoSaveToggle" /><span>自动保存</span></label>
          <label class="autosave-toggle" title="保存时自动在后台编译更新 PDF"><input type="checkbox" id="autoCompileToggle" /><span>保存即编译</span></label>
          <button class="button subtle" id="openProjectTop" title="打开或切换项目文件夹">打开项目</button>
          <button class="button subtle topbar-close-btn" id="topbarClose" type="button">收起菜单</button>
        </div>
        <button class="topbar-more-btn" id="topbarMore" type="button" aria-haspopup="true" aria-expanded="false" title="自动保存 / 打开项目">···</button>
        <button class="button subtle" id="saveButton" disabled>保存 <kbd>⌘S</kbd></button>
        <button class="button primary" id="compileButton" disabled><span class="play-icon">▶</span> 编译 PDF <kbd class="primary-kbd">⌘↵</kbd></button>
        <button class="button danger" id="cancelCompileButton" type="button" hidden title="中断正在进行的 Tectonic 编译，不用等它跑完">■ 取消编译</button>
      </div>
    </header>
    <div class="workspace" id="workspace">
      <aside class="sidebar">
        <div class="sidebar-heading">
          <div class="sidebar-ViewTabs" role="tablist" aria-label="侧栏视图">
            <button class="sidebar-tab active" data-side="files">项目文件</button>
            <button class="sidebar-tab" data-side="outline">文档大纲 <span id="outlineCount"></span></button>
          </div>
          <div class="sidebar-actions">
            <button class="icon-button" id="quickOpenBtn" title="快速打开文件或章节 (⌘P)" aria-label="快速打开">⚡</button>
            <button class="icon-button" id="searchProjectBtn" title="跨文件搜索 (⌘⇧F)" aria-label="跨文件搜索">🔍</button>
            <button class="icon-button" id="revealFinder" title="在 Finder 中打开项目文件夹" aria-label="在 Finder 中打开">📂</button>
            <button class="icon-button" id="refreshTree" title="刷新文件列表" aria-label="刷新文件列表">↻</button>
          </div>
        </div>
        <div id="filesSidePane" class="side-pane">
          <div class="project-path" id="projectPath">打开本机文件夹后，文件会显示在这里。</div>
          <div class="tree-filter-wrap" id="treeFilterWrap" hidden>
            <input type="search" id="treeFilterInput" placeholder="过滤文件名…" aria-label="过滤项目文件" />
          </div>
          <div class="tree" id="fileTree"></div>
          <button class="sidebar-add" id="newFile">＋ 新建 .tex / .bib 文件</button>
          <div class="sidebar-bottom">
            <div class="mini-heading">从模板开始</div>
            <button class="template-button" data-template="chinese"><span class="template-icon">中</span><span>中文论文<small>章节 · 摘要 · 目录</small></span><span class="chevron">›</span></button>
            <button class="template-button" data-template="english"><span class="template-icon english">EN</span><span>英文论文<small>Article 起步结构</small></span><span class="chevron">›</span></button>
          </div>
        </div>
        <div id="outlineSidePane" class="side-pane" hidden>
          <div class="outline-scope-bar">
            <button type="button" class="scope-chip active" data-outline-scope="project">全篇大纲</button>
            <button type="button" class="scope-chip" data-outline-scope="file">当前文件</button>
          </div>
          <div class="tree outline-tree" id="outlineTree"></div>
        </div>
      </aside>
      <main class="editor-panel">
        <div class="panel-toolbar editor-toolbar">
          <div class="file-tab" id="fileTab"><span class="file-tab-icon">T</span><span>未打开文件</span></div>
          <div class="toolbar-spacer"></div>
          <div class="editor-tools-group">
            <button type="button" class="toolbar-chip" id="syncToPdfBtn" title="在右侧 PDF 中定位当前光标所在位置 (⌘J)" disabled>定位 PDF ⇢</button>
            <button type="button" class="toolbar-chip" id="snippetCompileBtn" title="只编译当前选中的公式或段落进行极速预览 (⌘L)" disabled>选段预览</button>
            <div class="font-sizer" title="调整编辑器字号">
              <button type="button" id="fontSmaller" aria-label="缩小字号">A-</button>
              <button type="button" id="fontLarger" aria-label="放大字号">A+</button>
            </div>
          </div>
          <label class="root-picker">主文件 <select id="rootFile" aria-label="选择编译主文件"></select></label>
        </div>
        <div class="quickbar">
          <span class="quickbar-label">快捷插入</span>
          <button data-snippet="section" title="插入章节 \\section">章节</button>
          <button data-snippet="subsection" title="插入子章节 \\subsection">小节</button>
          <button data-snippet="bold" title="加粗 (⌘B)">加粗</button>
          <button data-snippet="italic" title="斜体 (⌘I)">斜体</button>
          <button data-snippet="inlineMath" title="行内公式 (⌘M)">$公式$</button>
          <button data-snippet="math" title="带编号行间公式">行间公式</button>
          <button data-snippet="itemize" title="无序列表">无序列表</button>
          <button data-snippet="enumerate" title="有序列表">有序列表</button>
          <button data-snippet="figure" title="快速插入图片浮动体">图片框</button>
          <button data-snippet="cite" title="插入文献引用">引用</button>
          <span class="quickbar-tip">粘贴/拖拽图片自动存图 · ⌘双击行选段预览</span>
        </div>
        <div class="conflict-bar" id="conflictBar" hidden>
          <span>⚠️ 该文件已在其他程序中被修改，直接保存会覆盖外部改动。</span>
          <div class="conflict-actions">
            <button type="button" class="conflict-btn" id="keepEditingConflict">继续编辑当前内容</button>
            <button type="button" class="conflict-btn" id="reloadConflictFile">重新加载磁盘版本</button>
            <button type="button" class="conflict-btn primary" id="forceSaveConflictFile">覆盖磁盘</button>
          </div>
        </div>
        <div class="editor-wrap">
          <div id="editor"></div>
          <div class="empty-editor" id="emptyEditor">
            <div class="empty-illustration">∑</div>
            <h1>让论文写作更顺手</h1>
            <p>打开本机 LaTeX 项目，直接编辑、编译并查看 PDF。</p>
            <button class="button primary" id="emptyOpen">打开项目文件夹</button>
            <div id="recentProjectsEmpty" class="recent-projects-empty" hidden></div>
            <div class="empty-hint">文件只保存在你的电脑中 · 按 ⌘P 随时快速切换文件</div>
          </div>
        </div>
        <div class="editor-footer">
          <div class="footer-left">
            <span id="fileStatus">等待打开文件</span>
            <button type="button" id="cursorPos" class="footer-cursor-btn" title="点击跳转到指定行号" hidden>行 1, 列 1</button>
          </div>
          <span id="wordCount" class="footer-stats"></span>
          <span class="footer-shortcuts">⌘P 跳转 <span>·</span> ⌘F 查找 <span>·</span> ⌘⇧F 全局搜 <span>·</span> ⌘J 定位PDF <span>·</span> ⌘↵ 编译</span>
        </div>
      </main>
      <div class="resizer" id="panelResizer" title="拖拽调整编辑区与右侧栏宽度" aria-label="调整分栏宽度"></div>
      <section class="inspector">
        <div class="inspector-tabs" role="tablist" aria-label="右侧面板">
          <button data-tab="preview" class="active">PDF 预览</button><button data-tab="insert">插入工具</button><button data-tab="references">引用 <span id="refTotalCount"></span></button><button data-tab="logs">编译日志 <span id="errorCount"></span></button>
        </div>
        <div class="inspector-content preview-pane" id="previewPane">
          <div class="preview-toolbar">
            <span id="previewCaption">尚未编译</span>
            <div class="preview-controls" id="previewControls" hidden>
              <button id="previousPage" title="上一页">‹</button>
              <span class="page-jumper"><input id="pageInput" type="number" min="1" value="1" aria-label="页码" /> / <span id="pageTotal">1</span></span>
              <button id="nextPage" title="下一页">›</button>
              <span class="control-divider"></span>
              <button id="zoomOut" title="缩小">−</button>
              <button id="zoomReset" class="zoom-label" title="点击切换适应页宽 / 整页">100%</button>
              <button id="zoomIn" title="放大">＋</button>
              <span class="control-divider"></span>
              <button id="togglePdfMode" class="mode-toggle" title="切换连续滚动窗口与单页模式">滚动</button>
            </div>
            <div class="preview-actions" id="previewActions" hidden>
              <a id="downloadPdf" class="preview-action-btn primary" download title="下载/导出当前终版 PDF 文件">导出 PDF ↓</a>
              <button id="revealPdf" class="preview-action-btn" type="button" title="在 macOS Finder 中直接高亮选中此 PDF 文件">📂 定位</button>
              <button id="cleanBuildTop" class="preview-action-btn danger" type="button" title="一键删除 .latex-tools/build 下的过程 PDF 与日志缓存">🗑️ 清理</button>
              <a id="openPdf" class="preview-action-btn" target="_blank" rel="noopener" title="在浏览器新标签页打开 PDF">打开 ↗</a>
            </div>
          </div>
          <div class="snippet-banner" id="snippetBanner" hidden>
            <span id="snippetBannerText">⚡ 当前为选段极速预览</span>
            <div class="snippet-banner-actions">
              <button type="button" class="snippet-btn" id="snippetBackToLine">跳回选段源码</button>
              <button type="button" class="snippet-btn primary" id="exitSnippetPreview">返回全文 PDF</button>
            </div>
          </div>
          <div class="pdf-stage" id="pdfStage" tabindex="0"><div class="preview-empty"><div class="preview-paper"><span></span><span></span><span></span><span></span></div><h2>预览你的论文</h2><p>选择主文件并点击“编译 PDF”（或选中片段按 ⌘L 极速预览）。</p></div></div>
        </div>
        <div class="inspector-content" id="insertPane" hidden>
          <div class="pane-intro"><h2>把想法写成 LaTeX</h2><p>填写内容，代码会插入编辑器当前光标位置。</p></div>
          <div class="tool-card">
            <div class="tool-title"><span class="tool-symbol">∑</span><div><strong>公式</strong><small>分类符号库 · 行间与多行公式</small></div></div>
            <div class="math-cat-tabs" id="mathCatTabs">
              <button type="button" class="active" data-math-cat="common">常用</button>
              <button type="button" data-math-cat="greek">希腊字母</button>
              <button type="button" data-math-cat="matrix">矩阵/结构</button>
              <button type="button" data-math-cat="relation">关系/箭头</button>
            </div>
            <div class="math-palette" id="mathPalette"></div>
            <label>公式内容（在框内按 ⌘↵ 可直接插入）<textarea id="equationInput" rows="3" placeholder="E = mc^2"></textarea></label>
            <div class="form-row"><label>标签（可选）<input id="equationLabel" placeholder="eq:energy" /></label><label>形式<select id="equationMode"><option value="equation">带编号 (equation)</option><option value="align">多行对齐 (align)</option><option value="display">不编号 (\\[ \\])</option><option value="inline">行内公式 ($ $)</option></select></label></div>
            <div class="tool-btn-row">
              <button class="button secondary" id="insertEquation" type="button">插入完整公式环境</button>
              <button class="button subtle" id="insertMathDirect" type="button" title="不包环境，仅把上方公式内容插入当前光标处">仅插入内容</button>
            </div>
          </div>
          <div class="tool-card">
            <div class="tool-title">
              <span class="tool-symbol">▦</span>
              <div><strong>表格</strong><small>支持从 Excel / Numbers / CSV 直接粘贴</small></div>
              <div class="tool-title-actions">
                <button type="button" class="mini-action-btn" id="pasteTableBtn" title="从剪贴板读取 Excel / TSV / CSV 表格数据自动填充">📋 粘贴数据</button>
                <button type="button" class="mini-action-btn" id="clearTableBtn" title="清空当前表格数据">清空</button>
              </div>
            </div>
            <div class="form-row">
              <label>行数<input id="tableRows" type="number" min="1" max="30" value="3" /></label>
              <label>列数<input id="tableCols" type="number" min="1" max="12" value="3" /></label>
            </div>
            <div class="form-row">
              <label>样式<select id="tableStyle"><option value="booktabs">学术三线表 (booktabs 推荐)</option><option value="grid">全边框表格 (hline)</option></select></label>
              <label>对齐<select id="tableAlign"><option value="c">居中 (c)</option><option value="l">左对齐 (l)</option><option value="r">右对齐 (r)</option></select></label>
            </div>
            <div id="tableGrid" class="table-grid" title="在任意单元格内按 ⌘V 可直接粘贴 Excel 多行多列数据"></div>
            <div class="form-row"><label>标题<input id="tableCaption" placeholder="实验结果对比" /></label><label>标签<input id="tableLabel" placeholder="tab:results" /></label></div>
            <button class="button secondary full" id="insertTable">插入表格</button>
          </div>
          <div class="tool-card"><div class="tool-title"><span class="tool-symbol">▧</span><div><strong>图片</strong><small>导入项目、预览并插入 figure</small></div></div>
            <label>项目图片<select id="imageSelect"></select></label>
            <div id="imageThumbWrap" class="image-thumb-wrap" hidden><img id="imageThumb" alt="图片预览" /><span id="imageThumbMeta"></span></div>
            <label class="upload-control">＋ 导入图片到 figures/（或直接粘贴/拖入编辑器） <input id="imageUpload" type="file" accept=".png,.jpg,.jpeg,.pdf,.eps,.svg" /></label>
            <div class="form-row"><label>标题<input id="imageCaption" placeholder="系统架构与实验流程" /></label><label>标签<input id="imageLabel" placeholder="fig:workflow" /></label></div>
            <label>宽度 <select id="imageWidth"><option value="0.8">80% 行宽</option><option value="1">100% 行宽</option><option value="0.6">60% 行宽</option><option value="0.5">50% 行宽</option></select></label>
            <button class="button secondary full" id="insertImage">插入图片</button>
          </div>
        </div>
        <div class="inspector-content" id="referencesPane" hidden>
          <div class="pane-intro">
            <div class="pane-intro-top"><h2>引用与交叉引用</h2><button class="text-button" id="refreshReferences">刷新列表 ↻</button></div>
            <p>点击条目插入引用到光标处，点右侧 <code>↗</code> 可定位到定义位置。</p>
            <div class="bib-quick-add">
              <span>＋ 新建文献：</span>
              <button type="button" data-bib-kind="article">期刊论文</button>
              <button type="button" data-bib-kind="inproceedings">会议论文</button>
              <button type="button" data-bib-kind="book">书籍</button>
              <button type="button" data-bib-kind="phdthesis">学位论文</button>
              <button type="button" data-bib-kind="misc">预印本/网页</button>
            </div>
            <input type="search" id="referenceSearch" class="search-input" placeholder="搜索文献 key、标题、作者或标签…" />
          </div>
          <div class="reference-section"><h3>文献条目 <span id="bibCount">0</span></h3><div id="bibList" class="reference-list"></div></div>
          <div class="reference-section"><h3>交叉引用 <span id="labelCount">0</span></h3><div id="labelList" class="reference-list"></div></div>
        </div>
        <div class="inspector-content log-pane" id="logsPane" hidden>
          <div class="pane-intro">
            <div class="pane-intro-top">
              <h2>编译结果</h2>
              <div class="log-top-actions">
                <button class="text-button" id="copyRawLog" type="button">复制日志</button>
                <button class="text-button danger-text" id="cleanBuildLogs" type="button">清理缓存 🗑️</button>
              </div>
            </div>
            <p id="compileSummary">编译后会在这里显示错误与完整输出。</p>
            <p class="build-storage-note">提示：编译报错行会在编辑器左侧标出提示点，按 <kbd>⌘⇧E</kbd> 可逐条跳到报错位置。</p>
            <div class="log-filter-bar" id="logFilterBar" hidden>
              <button type="button" class="scope-chip active" data-log-filter="all">全部</button>
              <button type="button" class="scope-chip" data-log-filter="error">仅错误</button>
              <button type="button" class="scope-chip" data-log-filter="warning">仅提示</button>
            </div>
          </div>
          <div id="diagnostics" class="diagnostics"></div>
          <div class="log-heading">原始输出</div><pre id="rawLog">暂无编译记录。</pre>
        </div>
      </section>
    </div>
    <dialog id="modal" class="modal">
      <form method="dialog">
        <button class="modal-close" value="cancel" aria-label="关闭">×</button>
        <h2 id="modalTitle"></h2>
        <p id="modalDescription"></p>
        <input id="modalInput" autocomplete="off" />
        <div id="modalRecentWrap" class="modal-recent-wrap" hidden></div>
        <div class="modal-actions"><button class="button subtle" value="cancel">取消</button><button class="button primary" id="modalSubmit" value="submit">确定</button></div>
        <button type="button" class="text-button" id="chooseFolder">用系统窗口选择文件夹</button>
      </form>
    </dialog>
    <dialog id="searchModal" class="modal search-modal">
      <div class="search-head">
        <div class="search-input-row">
          <input id="searchInput" type="search" placeholder="搜索所有 .tex / .bib 文件… (⌘⇧F)" autocomplete="off" />
          <button id="searchCase" class="search-flag" type="button" title="区分大小写">Aa</button>
          <button id="searchRegex" class="search-flag" type="button" title="正则表达式">.*</button>
        </div>
        <button class="modal-close search-close" type="button" id="searchClose" aria-label="关闭搜索">×</button>
      </div>
      <div class="search-meta" id="searchMeta">输入关键词开始搜索，回车或点击结果可跳转到对应行。</div>
      <div class="search-results" id="searchResults"></div>
      <div class="search-footer"><kbd>⏎</kbd> 打开 <span>·</span> <kbd>↑↓</kbd> 选择 <span>·</span> <kbd>Esc</kbd> 关闭 <span id="searchTruncated"></span></div>
    </dialog>
    <dialog id="quickOpenModal" class="modal search-modal quick-open-modal">
      <div class="search-head">
        <div class="search-input-row">
          <input id="quickOpenInput" type="search" placeholder="输入文件名或章节标题快速跳转… (⌘P)" autocomplete="off" />
        </div>
        <button class="modal-close search-close" type="button" id="quickOpenClose" aria-label="关闭快速跳转">×</button>
      </div>
      <div class="search-results" id="quickOpenResults"></div>
      <div class="search-footer"><kbd>⏎</kbd> 跳转 <span>·</span> <kbd>↑↓</kbd> 选择 <span>·</span> <kbd>Esc</kbd> 关闭</div>
    </dialog>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
  </div>`;

const $ = selector => document.querySelector(selector);
const editor = new EditorView({ state: EditorState.create({ doc: '', extensions }), parent: $('#editor') });
let modalAction = null;
let toastTimer = null;
let tableData = [];
let pdfDocument = null;
let pdfLoadedUrl = null;
// 当前已加载文档的「来源 + 内容指纹」，判断要不要真的重新取一份 PDF
let pdfLoadedToken = null;
let pdfCanvasPages = new Set();
let pdfCanvasBytes = 0;
// 连续模式下的页距，滚动时用它 O(1) 反推当前页
let pdfFirstPageTop = 0;
let pdfPageStride = 0;
// 程序滚动的宽限期：平滑滚动动画里不要让 scroll 回调把页码改回去
let pdfProgrammaticScrollUntil = 0;
let pdfPage = 1;
let pdfZoom = 1;
let pdfPageObserver = null;
let pdfRenderTasks = new Map();
let pdfGeneration = 0;
let resizeFrame = null;
let openFileToken = 0;
const fileSessions = new Map();
// 每个文件最多一个在途 PUT，重复的保存请求复用同一个 Promise
const saveInFlight = new Map();
// 最近导入过的图片内容指纹 → 项目内路径，防止连按 ⌘V 生成十几个 paste-…-2 副本
const recentPastedImages = new Map();
const RECENT_PASTE_TTL_MS = 120_000;

function applyEditorFontSize() {
  $('#editor').style.setProperty('--editor-font-size', `${state.editorFontSize}px`);
  $('#fontSmaller').disabled = state.editorFontSize <= 12;
  $('#fontLarger').disabled = state.editorFontSize >= 20;
}

$('#autoSaveToggle').checked = state.autoSave;
$('#autoCompileToggle').checked = state.autoCompile;
applyEditorFontSize();

// 换文档时用 oldState 复用 history / 面板 / 扩展状态，撤销栈不至于整篇作废；
// 选区与滚动位置只在仍处于同一文件时按字符偏移近似恢复。
function setDoc(content, { keepView = false } = {}) {
  const previous = editor.state;
  const anchor = keepView ? Math.min(previous.selection.main.anchor, content.length) : null;
  const head = keepView ? Math.min(previous.selection.main.head, content.length) : null;
  const scrollTop = keepView ? editor.scrollDOM.scrollTop : 0;
  editor.setState(EditorState.create({
    doc: content,
    oldState: previous,
    extensions,
    selection: keepView ? { anchor, head } : undefined
  }));
  if (keepView && scrollTop) {
    requestAnimationFrame(() => { editor.scrollDOM.scrollTop = scrollTop; });
  }
  state.dirty = false;
  statsCache.valid = false;
  $('#conflictBar').hidden = true;
  updateOutline();
  refreshEditorDiagnostics();
  renderCursorPosition();
}

function notify(message, kind = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3400);
}

// 兜底：任何冒泡到 window 的异常 / 悬空 Promise 都要让用户看见，不能只在控制台里静默失败。
let notifyLock = false;
function reportUnexpected(where, detail) {
  const message = detail?.message || detail?.reason?.message || String(detail || '');
  console.warn(`[砚台] ${where}`, detail);
  if (!notifyLock) {
    notifyLock = true;
    setTimeout(() => { notifyLock = false; }, 4000);
    notify(`界面出现异常（${where}）：${message || '详见浏览器控制台'}`, 'error');
  }
}
const windowErrorHandlers = {
  error: event => reportUnexpected('脚本错误', event.error || event.message),
  rejection: event => reportUnexpected('未处理的异步错误', event.reason)
};

function isTypingContext(target) {
  if (!target) return false;
  if (editor.dom.contains(target)) return false;
  if (target.closest?.('#searchModal')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// 默认 15s 超时：本机服务卡住时，自动保存 / 自动编译 / 后台引用扫描不至于永久挂起。
// 传 options.label 时失败会直接提示出来（调用方自己接管提示的就不传，避免双条 toast）。
async function request(url, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, label = null, ...fetchOptions } = options;
  const ownSignal = fetchOptions.signal || null;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...fetchOptions, signal: ownSignal || timeoutSignal });
  } catch (error) {
    if (ownSignal?.aborted) throw error;
    const failed = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? Object.assign(new Error(`本地服务 ${Math.round(timeoutMs / 1000)} 秒没有响应，请确认砚台还在运行`), { timedOut: true, status: 0 })
      : Object.assign(new Error('无法连接本地服务，请重新运行 ./start.sh'), { offline: true, status: 0 });
    if (label) notify(`${label}失败：${failed.message}`, 'error');
    throw failed;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `请求失败 (${response.status})`);
    err.status = response.status;
    if (label) notify(`${label}失败：${err.message}`, 'error');
    throw err;
  }
  return data;
}

function send(url, method, data, options = {}) {
  return request(url, { ...options, method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  $('#workspace').classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  $('#toggleSidebar').setAttribute('aria-expanded', state.sidebarCollapsed ? 'false' : 'true');
  if (pdfDocument) {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => renderPdfView(pdfGeneration, { preserveScroll: true }));
  }
}

// 窄窗口顶栏装不下时，把不常用入口收进「…」菜单（320px 宽也还点得到）
function toggleHeaderMenu(force) {
  const actions = $('.header-actions');
  const open = force == null ? !actions.classList.contains('menu-open') : force;
  actions.classList.toggle('menu-open', open);
  $('#topbarMore').setAttribute('aria-expanded', open ? 'true' : 'false');
}

// 最近项目：localStorage 在隐私模式 / 配额满时会抛异常，每次渲染只读一次缓存并 catch{return[]}
// 会把用户的列表静默清空。内存里始终留一份，读不到就沿用，写失败也只是这次不落盘。
let recentProjectsCache = [];

function normalizeRecentList(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string' || !item.trim() || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= 6) break;
  }
  return out;
}

function readStoredRecentProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem('yantai:recentProjects') || '[]');
    return Array.isArray(raw) ? normalizeRecentList(raw) : [];
  } catch {
    return null;
  }
}

function getRecentProjects() {
  const stored = readStoredRecentProjects();
  if (stored === null) return recentProjectsCache;
  let legacy = null;
  try { legacy = localStorage.getItem('yantai:lastProject'); } catch {}
  const merged = normalizeRecentList([...(legacy && !stored.includes(legacy) ? [legacy] : []), ...stored]);
  recentProjectsCache = merged;
  return merged;
}

function writeRecentProjects(list, lastProject) {
  const next = normalizeRecentList(list);
  recentProjectsCache = next;
  try {
    localStorage.setItem('yantai:recentProjects', JSON.stringify(next));
    if (lastProject !== undefined) localStorage.setItem('yantai:lastProject', lastProject);
  } catch {}
  renderRecentProjects();
}

function recordRecentProject(projectPath) {
  if (!projectPath) return;
  writeRecentProjects([projectPath, ...getRecentProjects().filter(p => p !== projectPath)], projectPath);
}

function removeRecentProject(projectPath) {
  const next = getRecentProjects().filter(p => p !== projectPath);
  let lastProject;
  try { if (localStorage.getItem('yantai:lastProject') === projectPath) lastProject = next[0] || ''; } catch {}
  writeRecentProjects(next, lastProject);
}

function renderRecentProjects() {
  const recent = getRecentProjects();
  const buildList = (container, inModal = false) => {
    if (!container) return;
    container.replaceChildren();
    const items = inModal ? recent : recent.filter(p => p !== state.projectRoot);
    if (!items.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const heading = document.createElement('div');
    heading.className = 'recent-heading';
    heading.textContent = '最近打开的项目';
    container.append(heading);
    const list = document.createElement('div');
    list.className = 'recent-list';
    for (const fullPath of items) {
      const row = document.createElement('div');
      row.className = 'recent-item' + (fullPath === state.projectRoot ? ' current' : '');
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'recent-open-btn';
      const name = document.createElement('strong');
      name.textContent = fullPath.split('/').filter(Boolean).pop() || fullPath;
      const sub = document.createElement('span');
      sub.textContent = fullPath;
      openBtn.append(name, sub);
      openBtn.addEventListener('click', () => {
        if ($('#modal').open) $('#modal').close('cancel');
        openProject(fullPath);
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'recent-remove-btn';
      delBtn.title = '从最近列表移除';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', event => {
        event.stopPropagation();
        removeRecentProject(fullPath);
      });
      row.append(openBtn, delBtn);
      list.append(row);
    }
    container.append(list);
  };
  buildList($('#recentProjectsEmpty'), false);
  buildList($('#modalRecentWrap'), true);
}

function showModal({ title, description, value = '', placeholder = '', submit = '确定', choose = false, action }) {
  $('#modalTitle').textContent = title;
  $('#modalDescription').textContent = description;
  $('#modalInput').value = value;
  $('#modalInput').placeholder = placeholder;
  $('#modalSubmit').textContent = submit;
  $('#chooseFolder').hidden = !choose;
  if (choose) renderRecentProjects();
  else $('#modalRecentWrap').hidden = true;
  modalAction = action;
  $('#modal').showModal();
  $('#modalInput').focus();
}

function askProject() {
  showModal({
    title: '打开本机项目',
    description: '选择包含 .tex 文件的文件夹，或粘贴完整路径。文件会直接保存在该文件夹。',
    value: state.projectRoot || '',
    placeholder: '/Users/你的名字/Documents/论文',
    submit: '打开文件夹',
    choose: true,
    action: value => openProject(value)
  });
}

async function openProject(folder, choose = false) {
  try {
    if (!choose && (!folder || !folder.trim())) return;
    if (state.dirty && !(await saveFile())) return;
    const data = choose
      ? await send('/api/project/choose', 'POST', {}, { timeoutMs: 60_000 })
      : await send('/api/project/open', 'POST', { path: folder.trim() }, { timeoutMs: 60_000 });
    if (!data?.projectRoot || !Array.isArray(data.files)) throw new Error('打开项目失败：服务端返回结果不完整');
    // 在途的 /api/file 响应必须作废，否则上一个项目的文件内容会落到新项目里
    openFileToken++;
    locateFileCache.clear();
    saveInFlight.clear();
    state.projectRoot = data.projectRoot;
    recordRecentProject(state.projectRoot);
    fileSessions.clear();
    fileDiagnostics.clear();
    state.collapsedFolders.clear();
    state.treeFilter = '';
    if ($('#treeFilterInput')) $('#treeFilterInput').value = '';
    state.files = data.files;
    state.activeFile = null;
    state.mtimeMs = null;
    state.dirty = false;
    state.wordCounts = {};
    state.projectOutline = [];
    state.fullCompileBackup = null;
    // localStorage 里记的主文件属于上一个项目时必须忽略，否则新文件夹一打开就编译一个不存在的主文件
    const savedRoot = (() => { try { return localStorage.getItem(`yantai:rootFile:${state.projectRoot}`); } catch { return null; } })();
    state.rootFile = (savedRoot && state.files.some(file => file.path === savedRoot && file.path.endsWith('.tex')))
      ? savedRoot
      : (state.files.find(file => file.path === 'main.tex')?.path || state.files.find(file => file.path.endsWith('.tex'))?.path || null);
    state.pdfUrl = null;
    state.pdfFingerprint = null;
    state.pdfStale = false;
    state.result = null;
    setDoc('');
    renderAll();
    if (data.truncated) notify('项目文件过多，文件列表只显示前 800 个（可用 ⌘P / ⌘⇧F 精确查找）', 'info');
    if (state.rootFile) await openFile(state.rootFile);
    scheduleReferences(80);
    notify(`已打开 ${state.projectRoot.split('/').filter(Boolean).pop()}`);
  } catch (error) { notify(error.message, 'error'); }
}

async function refreshTree() {
  if (!state.projectRoot) return;
  try {
    const data = await request('/api/tree');
    state.files = data.files;
    renderTree(); renderRootPicker(); renderImagePicker();
    scheduleReferences(100);
    notify(data.truncated ? '文件列表已刷新（文件过多，仅显示前 800 个）' : '文件列表已刷新');
  } catch (error) { notify(error.message, 'error'); }
}

async function revealInFinder() {
  if (!state.projectRoot) { notify('请先打开项目文件夹', 'error'); return; }
  try {
    await send('/api/project/reveal', 'POST', {});
  } catch {
    try {
      await navigator.clipboard.writeText(state.projectRoot);
      notify(`已复制路径：${state.projectRoot}`);
    } catch {
      notify(`项目路径：${state.projectRoot}`);
    }
  }
}

async function openFile(file, line = null) {
  if (!file || !state.files.some(item => item.path === file && item.type === 'text')) return;
  if (state.activeFile === file) {
    if (line) jumpToLine(line);
    editor.focus();
    return;
  }
  try {
    // 先把当前文件落盘并存好会话，再发请求：此后每个 await 只认下面的局部快照
    if (state.dirty && !(await saveFile())) return;
    const leavingFile = state.activeFile;
    if (leavingFile) {
      fileSessions.set(leavingFile, {
        editorState: editor.state,
        scrollTop: editor.scrollDOM.scrollTop,
        mtimeMs: state.mtimeMs
      });
    }
    const token = ++openFileToken;
    const data = await request(`/api/file?path=${encodeURIComponent(file)}`);
    // 快速连切两个文件时，先返回的那个必须作废，否则屏幕上显示 A、state.activeFile 是 B
    if (token !== openFileToken) return;
    state.activeFile = file;
    state.mtimeMs = data.mtimeMs;
    const cached = fileSessions.get(file);
    const reusable = cached
      && Math.abs((cached.mtimeMs || 0) - data.mtimeMs) <= 1
      && cached.editorState.doc.length === data.content.length
      && cached.editorState.doc.toString() === data.content;
    if (reusable) {
      editor.setState(cached.editorState);
      state.dirty = false;
      $('#conflictBar').hidden = true;
      updateOutline();
      refreshEditorDiagnostics();
      renderCursorPosition();
      renderTree(); renderFileStatus();
      if (!line) {
        const restoreTop = cached.scrollTop || 0;
        requestAnimationFrame(() => { editor.scrollDOM.scrollTop = restoreTop; });
      }
    } else {
      fileSessions.delete(file);
      setDoc(data.content);
      renderTree(); renderFileStatus();
      if (!line) editor.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
    }
    if (line) jumpToLine(line);
    editor.focus();
  } catch (error) { notify(error.message, 'error'); }
}

async function saveFile({ silent = false, force = false } = {}) {
  if (!state.activeFile || (!state.dirty && !force)) return true;
  // 在途的 PUT 复用：同一文件绝不并发 PUT（同 mtimeMs 连发两次必被服务端判 409 假冲突）
  const pending = saveInFlight.get(state.activeFile);
  if (pending) return pending;
  clearTimeout(autoSaveTimer);
  // 请求发出前一次性取快照；await 之后全局状态只能在这份内容还是屏幕内容时才回写
  const file = state.activeFile;
  const content = editor.state.doc.toString();
  const mtimeMs = state.mtimeMs;
  const snapshotSession = { editorState: editor.state, scrollTop: editor.scrollDOM.scrollTop };
  const task = (async () => {
    try {
      const data = await send('/api/file', 'PUT', { path: file, content, mtimeMs, force });
      const stillActive = file === state.activeFile;
      if (stillActive) {
        state.mtimeMs = data.mtimeMs;
        // 期间用户可能又打了字：只有屏幕内容仍是刚存的那份才算已保存
        state.dirty = editor.state.doc.toString() !== content;
        $('#conflictBar').hidden = true;
      }
      const previous = fileSessions.get(file);
      fileSessions.set(file, {
        editorState: previous?.editorState || snapshotSession.editorState,
        scrollTop: previous?.scrollTop ?? snapshotSession.scrollTop,
        mtimeMs: data.mtimeMs
      });
      if (stillActive) {
        renderFileStatus();
        if (!silent) notify(force ? '已覆盖保存到磁盘' : '已保存', force ? 'success' : 'info');
      }
      scheduleReferences(250);
      return true;
    } catch (error) {
      if (error.status === 409 && file === state.activeFile) $('#conflictBar').hidden = false;
      if (file === state.activeFile) notify(error.message, 'error');
      return false;
    } finally {
      saveInFlight.delete(file);
    }
  })();
  saveInFlight.set(file, task);
  return task;
}

async function reloadActiveFileFromDisk() {
  if (!state.activeFile) return;
  const file = state.activeFile;
  try {
    const data = await request(`/api/file?path=${encodeURIComponent(file)}`);
    if (file !== state.activeFile) return;
    openFileToken++;
    state.mtimeMs = data.mtimeMs;
    fileSessions.delete(file);
    setDoc(data.content);
    renderFileStatus();
    scheduleReferences(200);
    notify('已重新加载磁盘最新内容', 'success');
  } catch (error) {
    notify(error.message, 'error');
  }
}

let externalCheckInFlight = false;
async function checkExternalChange({ quiet = true } = {}) {
  if (!state.activeFile || !state.projectRoot || state.compiling || externalCheckInFlight) return;
  if (saveInFlight.has(state.activeFile)) return;
  const file = state.activeFile;
  externalCheckInFlight = true;
  try {
    const data = await request(`/api/file?path=${encodeURIComponent(file)}`);
    // 切文件 / 又开着保存：这次结果已经不属于当前屏幕上的内容了
    if (file !== state.activeFile || saveInFlight.has(file)) return;
    if (Math.abs((state.mtimeMs || 0) - data.mtimeMs) <= 1) return;
    if (!state.dirty) {
      // iCloud / OneDrive 同步或 Tectonic 写同目录都会碰 mtime。内容没变就只刷新 mtime，
      // 绝不能重建文档，否则撤销栈整篇作废、光标跳回顶部，还误报「已自动载入」。
      if (data.content === editor.state.doc.toString()) {
        state.mtimeMs = data.mtimeMs;
        const session = fileSessions.get(file);
        if (session) session.mtimeMs = data.mtimeMs;
        return;
      }
      state.mtimeMs = data.mtimeMs;
      fileSessions.delete(file);
      setDoc(data.content, { keepView: true });
      renderFileStatus();
      scheduleReferences(200);
      notify(`检测到外部修改，已自动载入 ${file}`, 'success');
    } else if (data.content !== editor.state.doc.toString()) {
      // Keep the stale mtime so the server's conflict guard still protects later saves
      $('#conflictBar').hidden = false;
      if (!quiet) notify('文件已在外部被修改，请选择保留哪一份', 'error');
    } else {
      state.mtimeMs = data.mtimeMs;
    }
  } catch {
    // File may have been deleted or renamed externally; keep the editor as-is
  } finally {
    externalCheckInFlight = false;
  }
}

async function revealPdfInFinder() {
  if (!state.projectRoot || !state.rootFile) { notify('请先编译生成 PDF', 'error'); return; }
  try {
    await send('/api/pdf/reveal', 'POST', { rootFile: state.rootFile });
    notify('已在 Finder 中高亮选中生成的 PDF');
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function cleanBuildArtifacts() {
  if (!state.projectRoot) { notify('请先打开项目文件夹', 'error'); return; }
  if (state.compiling) { notify('编译正在进行，请稍候再清理', 'error'); return; }
  try {
    await send('/api/build/clean', 'POST', {});
    state.pdfUrl = null;
    state.pdfFingerprint = null;
    state.pdfStale = false;
    state.result = null;
    state.fullCompileBackup = null;
    populateFileDiagnostics([]);
    renderResult();
    notify('已清空所有过程 PDF 与编译缓存', 'success');
  } catch (error) {
    notify(error.message, 'error');
  }
}

function jumpToLine(number) {
  const safeLine = Math.max(1, Math.min(number, editor.state.doc.lines));
  const line = editor.state.doc.line(safeLine);
  editor.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' })
  });
  editor.focus();
  requestAnimationFrame(() => {
    const domAt = editor.domAtPos(line.from);
    const lineEl = domAt?.node?.nodeType === 1 ? domAt.node.closest('.cm-line') : domAt?.node?.parentElement?.closest('.cm-line');
    if (lineEl) {
      lineEl.classList.remove('flash-target-line');
      void lineEl.offsetWidth;
      lineEl.classList.add('flash-target-line');
    }
  });
}

// 「编译中」期间编译按钮保持禁用，取消入口单独放旁边，避免把主按钮的文案改成两种语义
const compileButtonHtml = $('#compileButton').innerHTML;
const cancelCompileButtonHtml = $('#cancelCompileButton').innerHTML;

function makeCompileToken() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(uuid)) return uuid;
  // 非安全上下文没有 randomUUID，退而拼一个仍满足契约字符集限制的 token
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `c-${Date.now().toString(36)}-${rand()}${rand()}`.slice(0, 64);
}

function setCompileBusy(busy, label) {
  state.compiling = busy;
  const compileButton = $('#compileButton');
  const cancelButton = $('#cancelCompileButton');
  compileButton.disabled = busy || !state.rootFile;
  compileButton.innerHTML = busy ? `<span class="spinner"></span> ${label}` : compileButtonHtml;
  cancelButton.hidden = !busy;
  cancelButton.disabled = false;
  cancelButton.innerHTML = cancelCompileButtonHtml;
  if (!busy) state.compileToken = null;
}

// POST /api/compile/cancel {token}；未命中（已结束的编译）按契约也是 200，忽略即可
function cancelCurrentCompile() {
  const token = state.compileToken;
  if (!token) return;
  $('#cancelCompileButton').disabled = true;
  $('#cancelCompileButton').textContent = '正在取消…';
  send('/api/compile/cancel', 'POST', { token }, { label: '取消编译' }).catch(() => {});
}

// 契约 §3/§7：pdfFresh 才允许切预览，pdfStale 保持不动，绝不把上一版 PDF 当新结果
function applyCompileFreshness(result) {
  if (result.pdfAvailable && result.pdfFresh) {
    state.pdfUrl = result.pdfUrl;
    state.pdfFingerprint = result.pdfFingerprint;
    state.pdfStale = false;
  } else if (result.pdfAvailable) {
    state.pdfStale = true;
  } else {
    state.pdfUrl = null;
    state.pdfFingerprint = null;
    state.pdfStale = false;
  }
}

async function compile({ silentSuccess = false, silent = false } = {}) {
  if (!state.projectRoot || state.compiling || !state.rootFile) return;
  if (state.dirty && !(await saveFile({ silent: true }))) return;
  if (!state.rootFile) return;
  // 保存期间用户可能换了主文件：之后都认这份快照，回来时主文件若已变就丢掉这次结果
  const rootAtStart = state.rootFile;
  const token = makeCompileToken();
  state.fullCompileBackup = null;
  // 标志只包住真正在途的这一个请求；之前放在 await 之前会在 saveFile 返回 false 时永久泄漏
  state.compiling = true;
  state.compileToken = token;
  setCompileBusy(true, '编译中…');
  $('#previewCaption').textContent = '正在编译…';
  let result;
  try {
    result = await send('/api/compile', 'POST', { rootFile: rootAtStart, token }, { signal: AbortSignal.timeout(COMPILE_TIMEOUT_MS + 10_000) });
  } catch (error) {
    if (error.status === 409) {
      // 服务端已有编译任务：自动编译静默跳过，手动点提示一句。
      // 409 走服务端统一 errorEnvelope（{ error: '…' }）：直接显示服务端给的原因，比写死文案准
      if (!silent) notify(error.message || '已有编译任务正在进行，请稍候', 'error');
    } else {
      notify(error.message, 'error');
      $('#previewCaption').textContent = '编译未完成';
    }
    return;
  } finally {
    setCompileBusy(false);
  }
  if (result.cancelled) {
    // 取消：保留原有的 result / pdfUrl，只提示一句
    renderResult({ keepPdf: true });
    notify('已取消编译', 'info');
    return;
  }
  if (rootAtStart !== state.rootFile) {
    notify('已切换主文件，这次编译结果已忽略', 'info');
    return;
  }
  const wasSnippet = Boolean(state.result?.snippet);
  // 用服务端内容指纹判断，不再比 URL 字符串：同一毫秒编译两次也不会停在上一版
  const unchanged = !wasSnippet && result.pdfAvailable && Boolean(state.pdfUrl) && result.pdfFingerprint === state.pdfFingerprint;
  state.result = result;
  applyCompileFreshness(result);
  populateFileDiagnostics(result.diagnostics || []);
  renderResult({ keepPdf: unchanged });
  if (!result.ok) showTab('logs');
  else if (state.tab === 'logs') showTab('preview');
  if (!silentSuccess || !result.ok) {
    const timeTag = result.durationMs ? ` (${(result.durationMs / 1000).toFixed(1)}s)` : '';
    notify(result.ok ? `编译完成${timeTag}` : '编译失败，请查看日志（按 ⌘⇧E 跳转错误行）', result.ok ? 'success' : 'error');
  }
}

async function compileSnippet({ source, editorFile, fromLine, toLine, bodyStart }) {
  if (!state.projectRoot || state.compiling) return;
  const rootAtStart = state.rootFile;
  const token = makeCompileToken();
  if (!state.result?.snippet && (state.pdfUrl || state.result)) {
    state.fullCompileBackup = {
      result: state.result,
      pdfUrl: state.pdfUrl,
      pdfFingerprint: state.pdfFingerprint
    };
  }
  state.compiling = true;
  state.compileToken = token;
  setCompileBusy(true, '选段编译中…');
  $('#previewCaption').textContent = `正在极速编译选段（第 ${fromLine}–${toLine} 行）…`;
  let result;
  try {
    result = await send('/api/compile/snippet', 'POST', {
      source,
      editorFile,
      fromLine,
      bodyStart,
      rootFile: rootAtStart,
      token
    }, { signal: AbortSignal.timeout(SNIPPET_TIMEOUT_MS + 10_000) });
  } catch (error) {
    // 409 的响应体是服务端统一 errorEnvelope，直接念服务端的原因
    if (error.status === 409) notify(error.message || '已有编译任务正在进行，请稍候', 'error');
    else notify(error.message, 'error');
    $('#previewCaption').textContent = '选段编译未完成';
    return;
  } finally {
    setCompileBusy(false);
  }
  if (result.cancelled) {
    renderResult({ keepPdf: true });
    notify('已取消选段编译', 'info');
    return;
  }
  if (rootAtStart !== state.rootFile) {
    notify('已切换主文件，这次编译结果已忽略', 'info');
    return;
  }
  result.snippetMeta = { editorFile, fromLine, toLine };
  state.result = result;
  if (result.pdfAvailable && result.pdfFresh) {
    state.pdfUrl = result.pdfUrl;
    state.pdfFingerprint = result.pdfFingerprint;
    state.pdfStale = false;
  } else if (result.pdfAvailable) {
    state.pdfStale = true;
  } else if (!result.ok) {
    state.pdfUrl = null;
    state.pdfFingerprint = null;
    state.pdfStale = false;
  }
  if (!result.ok) populateFileDiagnostics(result.diagnostics || []);
  renderResult({ keepPdf: false });
  if (!result.ok) showTab('logs');
  else showTab('preview');
  const timeTag = result.durationMs ? ` (${(result.durationMs / 1000).toFixed(1)}s)` : '';
  notify(result.ok ? `选段预览完成${timeTag}` : '选段编译失败，请检查选中语法是否完整', result.ok ? 'success' : 'error');
}

function exitSnippetPreview() {
  if (state.fullCompileBackup) {
    state.result = state.fullCompileBackup.result;
    state.pdfUrl = state.fullCompileBackup.pdfUrl;
    state.pdfFingerprint = state.fullCompileBackup.pdfFingerprint;
    state.fullCompileBackup = null;
    populateFileDiagnostics(state.result?.diagnostics || []);
    renderResult({ keepPdf: false });
    notify('已返回全文 PDF 预览');
  } else {
    state.result = null;
    state.pdfUrl = null;
    renderResult({ keepPdf: false });
    if (state.rootFile) compile();
  }
}

function setSidebarMode(mode) {
  state.sidebarMode = mode;
  document.querySelectorAll('[data-side]').forEach(btn => btn.classList.toggle('active', btn.dataset.side === mode));
  $('#filesSidePane').hidden = mode !== 'files';
  $('#outlineSidePane').hidden = mode !== 'outline';
  if (mode !== 'outline') return;
  // 连点标签 / 与 ⌘\\ 折叠同时触发时只重建一次；rAF 里重建才不会卡住这次点击的绘制
  lastOutlineCursorLine = -1;
  if (outlineRenderFrame) cancelAnimationFrame(outlineRenderFrame);
  outlineRenderFrame = requestAnimationFrame(() => {
    outlineRenderFrame = 0;
    renderOutline();
  });
}

const clientHeadingRegex = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/;
const clientLevelMap = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };

function parseBufferOutline(text, filePath) {
  const items = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/(?<!\\)%.*/, '');
    const match = clean.match(clientHeadingRegex);
    if (match) {
      items.push({
        file: filePath,
        level: clientLevelMap[match[1]] ?? 1,
        kind: match[1],
        title: match[2].trim() || '(未命名章节)',
        line: i + 1
      });
    }
  }
  return items;
}

function getEffectiveOutline() {
  if (state.outlineMode === 'file' || !state.projectOutline.length) {
    return state.outline;
  }
  if (!state.activeFile?.endsWith('.tex')) return state.projectOutline;
  // Splice live unsaved headings of the active file into the project-wide outline at its first occurrence
  const hasActiveInProject = state.projectOutline.some(item => item.file === state.activeFile);
  if (!hasActiveInProject) {
    return [...state.projectOutline, ...state.outline];
  }
  const merged = [];
  let inserted = false;
  for (const item of state.projectOutline) {
    if (item.file === state.activeFile) {
      if (!inserted) {
        merged.push(...state.outline);
        inserted = true;
      }
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function currentOutlineIndex(items) {
  if (!state.activeFile || !items.length) return -1;
  const cursorLine = editor.state.doc.lineAt(editor.state.selection.main.head).number;
  let current = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.file === state.activeFile && item.line <= cursorLine) current = i;
  }
  return current;
}

function updateOutline() {
  state.outline = (state.activeFile && state.activeFile.endsWith('.tex'))
    ? parseBufferOutline(editor.state.doc.toString(), state.activeFile)
    : [];
  const effective = getEffectiveOutline();
  $('#outlineCount').textContent = effective.length ? String(effective.length) : '';
  // 大纲面板没露出时不重建几百个节点；切过去时 setSidebarMode 负责重建
  if (state.sidebarMode === 'outline') renderOutline(effective);
}

function renderOutline(precomputed) {
  const container = $('#outlineTree');
  if (!container) return;
  document.querySelectorAll('[data-outline-scope]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.outlineScope === state.outlineMode);
  });
  container.replaceChildren();
  if (!state.projectRoot) {
    const empty = document.createElement('div'); empty.className = 'tree-empty'; empty.textContent = '请先打开项目查看章节大纲。'; container.append(empty); return;
  }
  const items = precomputed || getEffectiveOutline();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = state.outlineMode === 'file' ? '当前文件还没有章节标题（可切换到“全篇大纲”查看各章结构）。' : '项目中还没有 \\chapter 或 \\section 标题。';
    container.append(empty);
    return;
  }
  const multiFile = new Set(items.map(i => i.file)).size > 1;
  const current = currentOutlineIndex(items);
  lastOutlineCursorLine = state.activeFile ? editor.state.doc.lineAt(editor.state.selection.main.head).number : -1;
  const fragment = document.createDocumentFragment();
  for (const [index, item] of items.entries()) {
    const button = document.createElement('button');
    button.className = `outline-item level-${item.level}` + (index === current ? ' current' : '');
    button.title = `${item.title} (${item.file}:${item.line})`;
    const title = document.createElement('span');
    title.className = 'outline-title';
    title.textContent = item.title;
    const metaWrap = document.createElement('span');
    metaWrap.className = 'outline-meta';
    if (multiFile && item.file) {
      const fileTag = document.createElement('span');
      fileTag.className = 'outline-file-tag';
      fileTag.textContent = item.file.split('/').pop().replace(/\.tex$/i, '');
      metaWrap.append(fileTag);
    }
    const lineTag = document.createElement('span');
    lineTag.className = 'outline-line';
    lineTag.textContent = `L${item.line}`;
    metaWrap.append(lineTag);
    button.append(title, metaWrap);
    button.addEventListener('click', () => {
      if (item.file && item.file !== state.activeFile) openFile(item.file, item.line);
      else jumpToLine(item.line);
    });
    fragment.append(button);
  }
  // 整棵树先在片段里建好，再一次插入，避免几百个节点反复触发布局
  container.append(fragment);
}

// 只在光标进入新行时刷新大纲高亮：一次线性扫描 + 一次 class 切换，不再 O(n²) 重建
function highlightOutlineAtCursor() {
  if (state.sidebarMode !== 'outline' || !state.activeFile) return;
  const cursorLine = editor.state.doc.lineAt(editor.state.selection.main.head).number;
  if (cursorLine === lastOutlineCursorLine) return;
  lastOutlineCursorLine = cursorLine;
  const current = currentOutlineIndex(getEffectiveOutline());
  const container = $('#outlineTree');
  if (!container) return;
  // 同步读游标位置，class 写入推到 rAF，写读不交错就不会强制 reflow
  if (outlineHighlightFrame) cancelAnimationFrame(outlineHighlightFrame);
  outlineHighlightFrame = requestAnimationFrame(() => {
    outlineHighlightFrame = 0;
    container.querySelectorAll('.outline-item').forEach((button, index) => {
      button.classList.toggle('current', index === current);
    });
  });
}

// 字数统计的三个正则本身线性，但 100 页中文正文连乘每次光标移动就是几十毫秒级卡顿。
// 结果按「文件 + doc 版本」缓存：doc 没变直接复用，光标移动只重算选区那一小段。
let wordCountsEpoch = 0;
const statsCache = {
  key: '',
  valid: false,
  cjk: 0,
  words: 0,
  total: 0,
  selectionKey: '',
  selectionTotal: 0,
  projectTag: ''
};

// 去掉未转义的 % 之后的行内注释。扫描实现，语义与服务端 computePlainWordStats 的
// (?<!\\)%.* 完全一致：只要前一个字符是反斜杠就不算注释（含 `\\%` 这种情况）。
function stripLatexComments(content) {
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) !== 37) continue;
    if (i > 0 && content.charCodeAt(i - 1) === 92) continue;
    const eol = content.indexOf('\n', i);
    const stop = eol === -1 ? content.length : eol;
    parts.push(content.slice(cursor, i));
    parts.push(content.slice(stop, stop + 1));
    cursor = stop + 1;
    i = stop;
  }
  if (!parts.length) return content;
  parts.push(content.slice(cursor));
  return parts.join('');
}

// 三个替换正则都是线性量级；100 页正文单次约几毫秒，配合上面的版本缓存后只在防抖里跑
function computeTextStats(content) {
  const stripped = stripLatexComments(content)
    .replace(/\\(?:begin|end)\{[^}]*\}/g, ' ')
    .replace(/\\(?:label|ref|eqref|autoref|pageref|cite[a-zA-Z]*|includegraphics|usepackage|documentclass|bibliographystyle|bibliography|input|include)(?:\[[^\]]*\])?\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+/g, ' ');
  let cjk = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  let words = 0;
  if (/[A-Za-z0-9]/.test(stripped)) {
    const latin = stripped.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g);
    words = latin ? latin.length : 0;
  }
  return { cjk, words, total: cjk + words };
}

function renderAll() {
  $('#projectName').textContent = state.projectRoot ? state.projectRoot.split('/').filter(Boolean).pop() : '尚未打开项目';
  $('#projectPath').textContent = state.projectRoot || '打开本机文件夹后，文件会显示在这里。';
  $('#newFile').disabled = !state.projectRoot;
  $('#compileButton').disabled = !state.rootFile;
  renderRecentProjects();
  renderTree(); renderOutline(); renderRootPicker(); renderImagePicker(); renderMathPalette(); renderFileStatus(); renderResult();
}

function renderTree() {
  const tree = $('#fileTree');
  tree.replaceChildren();
  const filterWrap = $('#treeFilterWrap');
  if (filterWrap) filterWrap.hidden = !state.projectRoot || state.files.length < 6;
  if (!state.projectRoot) {
    const empty = document.createElement('div'); empty.className = 'tree-empty'; empty.textContent = '还没有打开项目'; tree.append(empty); return;
  }
  if (!state.files.length) {
    const empty = document.createElement('div'); empty.className = 'tree-empty'; empty.textContent = '文件夹里还没有 LaTeX 文件，可以从下方模板开始。'; tree.append(empty); return;
  }
  const filter = state.treeFilter.trim().toLowerCase();
  const visibleFiles = filter ? state.files.filter(f => f.path.toLowerCase().includes(filter)) : state.files;
  if (!visibleFiles.length) {
    const empty = document.createElement('div'); empty.className = 'tree-empty'; empty.textContent = '没有匹配该名称的文件。'; tree.append(empty); return;
  }

  const folderCounts = new Map();
  for (const file of visibleFiles) {
    const folder = file.path.split('/').slice(0, -1).join('/');
    if (folder) folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
  }

  let previousFolder = '';
  for (const file of visibleFiles) {
    const pieces = file.path.split('/');
    const folder = pieces.slice(0, -1).join('/');
    const isCollapsed = folder && !filter && state.collapsedFolders.has(folder);
    if (folder && folder !== previousFolder) {
      const folderBtn = document.createElement('button');
      folderBtn.type = 'button';
      folderBtn.className = 'folder-row';
      folderBtn.dataset.folder = folder;
      const arrow = isCollapsed ? '▸' : '▾';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = `${arrow}  ${folder}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'folder-count';
      countSpan.textContent = String(folderCounts.get(folder) || 0);
      folderBtn.append(labelSpan, countSpan);
      tree.append(folderBtn);
      previousFolder = folder;
    }
    if (isCollapsed) continue;

    const row = document.createElement('div');
    row.className = 'tree-file-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tree-file' + (state.activeFile === file.path ? ' active' : '');
    button.dataset.path = file.path;
    button.title = file.type === 'image' ? `${file.path}（点击预览或插入图片）` : file.path;
    const icon = document.createElement('span');
    icon.className = 'tree-icon ' + (file.type === 'image' ? 'image' : file.path.endsWith('.bib') ? 'bib' : 'tex');
    icon.textContent = file.type === 'image' ? '▧' : file.path.endsWith('.bib') ? 'B' : 'T';
    const name = document.createElement('span');
    name.className = 'tree-filename';
    name.textContent = pieces.at(-1);
    button.append(icon, name);

    const diags = fileDiagnostics.get(file.path) || [];
    if (diags.length) {
      const hasErr = diags.some(d => d.kind === 'error');
      const dot = document.createElement('span');
      dot.className = 'tree-diag-dot ' + (hasErr ? 'error' : 'warning');
      dot.title = `${diags.length} 条编译${hasErr ? '错误' : '提示'}`;
      button.append(dot);
    }

    if (file.path === state.rootFile) {
      const badge = document.createElement('span');
      badge.className = 'root-badge';
      badge.textContent = '主';
      button.append(badge);
    }
    row.append(button);
    if (file.path.endsWith('.tex') && file.path !== state.rootFile) {
      const setRootBtn = document.createElement('button');
      setRootBtn.type = 'button';
      setRootBtn.className = 'set-root-btn';
      setRootBtn.dataset.setRoot = file.path;
      setRootBtn.title = `将 ${file.path} 设为编译主文件`;
      setRootBtn.textContent = '设为主';
      row.append(setRootBtn);
    }
    tree.append(row);
  }
}

function renderRootPicker() {
  const select = $('#rootFile');
  select.replaceChildren();
  const files = state.files.filter(file => file.path.endsWith('.tex'));
  if (!files.length) select.add(new Option('无 .tex 文件', ''));
  else for (const file of files) select.add(new Option(file.path, file.path));
  select.value = state.rootFile || '';
  select.disabled = !files.length;
}

function renderImagePicker() {
  const select = $('#imageSelect');
  const old = select.value;
  select.replaceChildren();
  const images = state.files.filter(file => file.type === 'image');
  if (!images.length) select.add(new Option('暂无图片，请先导入', ''));
  else for (const file of images) select.add(new Option(file.path, file.path));
  if (images.some(file => file.path === old)) select.value = old;
  updateImageThumb();
}

function updateImageThumb() {
  const file = $('#imageSelect').value;
  const wrap = $('#imageThumbWrap');
  const img = $('#imageThumb');
  const meta = $('#imageThumbMeta');
  if (!file || !/\.(png|jpe?g|svg)$/i.test(file)) {
    wrap.hidden = true;
    img.removeAttribute('src');
    return;
  }
  wrap.hidden = false;
  img.src = `/api/asset?path=${encodeURIComponent(file)}&t=${Date.now()}`;
  meta.textContent = file;
}

function renderCursorPosition() {
  const btn = $('#cursorPos');
  if (!btn) return;
  if (!state.activeFile) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const head = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(head);
  const col = head - line.from + 1;
  btn.textContent = `行 ${line.number}, 列 ${col}`;
}

// 光标移动 / 状态刷新都会走这里：doc 版本没变时只重算选区，绝不重跑全篇正则
function renderWordCount() {
  const el = $('#wordCount');
  if (!el) return;
  if (!state.activeFile) {
    statsCache.valid = false;
    statsCache.projectTag = '';
    el.textContent = '';
    el.title = '';
    return;
  }
  const doc = editor.state.doc;
  const key = `${state.activeFile}|${doc.version}`;
  if (!statsCache.valid || statsCache.key !== key) {
    try {
      const stats = computeTextStats(doc.toString());
      statsCache.key = key;
      statsCache.cjk = stats.cjk;
      statsCache.words = stats.words;
      statsCache.total = stats.total;
      statsCache.valid = true;
      statsCache.projectTag = '';
      statsCache.projectTagKey = '';
    } catch (error) {
      // 统计失败不能连锁影响编辑，状态栏显示上一次的结果
      console.warn('[砚台] 字数统计失败', error);
      el.textContent = '';
      return;
    }
  }
  const range = editor.state.selection.main;
  let selected = '';
  if (!range.empty) {
    const selectionKey = `${range.from}:${range.to}`;
    if (statsCache.selectionKey !== selectionKey) {
      try {
        statsCache.selectionTotal = computeTextStats(doc.sliceString(range.from, range.to)).total;
        statsCache.selectionKey = selectionKey;
      } catch (error) {
        console.warn('[砚台] 选区字数统计失败', error);
        statsCache.selectionTotal = 0;
        statsCache.selectionKey = selectionKey;
      }
    }
    selected = ` · 选中 ${statsCache.selectionTotal.toLocaleString()} 字`;
  } else {
    statsCache.selectionKey = '';
  }
  // 全篇字数来自服务端扫描（含未保存缓冲），只有结果换了一轮才拼一次
  const projectKey = `${state.activeFile}|${wordCountsEpoch}`;
  if (statsCache.projectTagKey !== projectKey) {
    let projectTag = '';
    if (state.activeFile.endsWith('.tex')) {
      let otherTotal = 0;
      let others = 0;
      for (const [path, entry] of Object.entries(state.wordCounts)) {
        if (path === state.activeFile) continue;
        others++;
        otherTotal += entry?.total || 0;
      }
      if (others > 0) projectTag = ` · 全篇 ${(statsCache.total + otherTotal).toLocaleString()} 字`;
    }
    statsCache.projectTag = projectTag;
    statsCache.projectTagKey = projectKey;
  }
  el.textContent = `本文件 ${statsCache.total.toLocaleString()} 字${statsCache.projectTag}${selected}`;
  el.title = `当前文件：中文 ${statsCache.cjk} 字 · 英文 ${statsCache.words} 词`;
}

function renderFileStatus() {
  const label = $('#fileTab');
  label.querySelector('span:last-child').textContent = state.activeFile || '未打开文件';
  label.classList.toggle('dirty', state.dirty);
  $('#fileStatus').textContent = state.activeFile
    ? `${state.dirty ? (state.autoSave ? '● 待自动保存 · ' : '● 未保存 · ') : '✓ 已保存 · '}${editor.state.doc.lines} 行 · ${state.activeFile}`
    : '等待打开文件';
  renderCursorPosition();
  renderWordCount();
  const isTex = Boolean(state.activeFile?.endsWith('.tex'));
  $('#saveButton').disabled = !state.dirty;
  $('#syncToPdfBtn').disabled = !isTex || !state.rootFile;
  $('#snippetCompileBtn').disabled = !isTex;
  $('#emptyEditor').hidden = Boolean(state.activeFile);
}

function showTab(tab) {
  state.tab = tab;
  for (const name of ['preview', 'insert', 'references', 'logs']) {
    $(`#${name === 'preview' ? 'previewPane' : name === 'insert' ? 'insertPane' : name === 'references' ? 'referencesPane' : 'logsPane'}`).hidden = name !== tab;
    document.querySelector(`[data-tab="${name}"]`).classList.toggle('active', name === tab);
  }
  if (tab === 'references') loadReferences({ silent: true });
  if (tab === 'preview' && pdfDocument) {
    requestAnimationFrame(() => renderPdfView(pdfGeneration, { preserveScroll: true }));
  }
}

function renderDiagnosticsList() {
  const result = state.result;
  const allItems = result?.diagnostics || [];
  const errCount = allItems.filter(i => i.kind === 'error').length;
  const warnCount = allItems.filter(i => i.kind !== 'error').length;
  const filterBar = $('#logFilterBar');
  if (filterBar) {
    filterBar.hidden = !(errCount > 0 && warnCount > 0);
    if (filterBar.hidden && state.logFilter !== 'all') state.logFilter = 'all';
    filterBar.querySelectorAll('[data-log-filter]').forEach(btn => {
      const f = btn.dataset.logFilter;
      btn.classList.toggle('active', f === state.logFilter);
      if (f === 'all') btn.textContent = `全部 (${allItems.length})`;
      else if (f === 'error') btn.textContent = `错误 (${errCount})`;
      else if (f === 'warning') btn.textContent = `提示 (${warnCount})`;
    });
  }

  const diagnostics = $('#diagnostics');
  diagnostics.replaceChildren();
  const shown = state.logFilter === 'all' ? allItems : allItems.filter(i => (state.logFilter === 'error' ? i.kind === 'error' : i.kind !== 'error'));
  for (const item of shown) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diagnostic ' + item.kind;
    const top = document.createElement('span');
    top.className = 'diagnostic-top';
    top.textContent = `${item.kind === 'error' ? '错误' : '提示'}${item.file ? ` · ${item.file}` : ''}${item.line ? `:${item.line}` : ''}`;
    const message = document.createElement('strong');
    message.textContent = item.message;
    button.append(top, message);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'diagnostic-hint';
      hint.textContent = `💡 ${item.hint}`;
      button.append(hint);
    }
    button.addEventListener('click', async () => {
      if (item.file && state.files.some(file => file.path === item.file)) await openFile(item.file, item.line);
      else if (item.line && state.rootFile) await openFile(state.rootFile, item.line);
    });
    diagnostics.append(button);
  }
  if (result && !shown.length) {
    const empty = document.createElement('div');
    empty.className = 'diagnostic-empty';
    empty.textContent = result.ok ? '没有发现错误。' : '没有提取到具体行号，请查看下方原始输出。';
    diagnostics.append(empty);
  }
  // 服务端最多报 100 条：悄悄截断会让用户以为「就这些错」，按 ⌘⇧E 循环跳转时也会少跳
  const hiddenCount = (result?.diagnosticsTotal || 0) - allItems.length;
  if (result?.diagnosticsTruncated && hiddenCount > 0) {
    const more = document.createElement('div');
    more.className = 'log-hidden-hint';
    more.textContent = `另有 ${hiddenCount} 条未显示，请修复上面的错误后重新编译`;
    diagnostics.append(more);
  }
}

function renderResult({ keepPdf = false } = {}) {
  const result = state.result;
  const count = result?.diagnostics?.filter(item => item.kind === 'error').length || 0;
  const timeInfo = result?.durationMs ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : '';
  const isSnippet = Boolean(result?.snippet);
  $('#errorCount').textContent = count ? String(count) : '';
  $('#compileSummary').textContent = !result
    ? '编译后会在这里显示错误与完整输出。'
    : result.ok
      ? `${isSnippet ? '选段编译成功' : '编译成功'}${timeInfo}${result.diagnostics.length ? `，有 ${result.diagnostics.length} 条提示` : ''}。`
      : `${isSnippet ? '选段编译失败' : '编译失败'}${count ? `，发现 ${count} 条错误` : ''}。`;
  $('#rawLog').textContent = result?.output || '暂无编译记录。';
  renderDiagnosticsList();

  const snippetBanner = $('#snippetBanner');
  if (snippetBanner) {
    snippetBanner.hidden = !isSnippet;
    if (isSnippet && result?.snippetMeta) {
      $('#snippetBannerText').textContent = `⚡ 选段极速预览 · ${result.snippetMeta.editorFile} 第 ${result.snippetMeta.fromLine}–${result.snippetMeta.toLine} 行`;
    }
  }

  if (state.pdfUrl) {
    const baseName = isSnippet
      ? 'snippet-preview.pdf'
      : (state.rootFile || 'document.tex').split('/').pop().replace(/\.tex$/i, '') + '.pdf';
    // 同一份 PDF 的 full / snippet 是两个入口，用「来源 + 服务端内容指纹」当文档标记，
    // 切回来时一定会重新加载，同一毫秒编译两次也不会停在上一版
    const fingerprintTag = String(result?.pdfFingerprint || '');
    const pdfToken = fingerprintTag
      ? `${isSnippet ? 'snippet' : 'full'}|${fingerprintTag}`
      : `${isSnippet ? 'snippet' : 'full'}|url:${state.pdfUrl}`;
    const stale = !isSnippet && (state.pdfStale || (result && !result.ok && result.pdfAvailable));
    $('#previewCaption').textContent = isSnippet
      ? `选段 PDF${timeInfo}`
      : (result?.ok && !stale ? `最新 PDF${timeInfo} · 双击页面反向定位源码` : '上一次成功生成的 PDF');
    $('#openPdf').href = state.pdfUrl;
    $('#downloadPdf').href = `${state.pdfUrl}&download=1`;
    $('#downloadPdf').setAttribute('download', baseName);
    $('#revealPdf').hidden = isSnippet;
    $('#previewActions').hidden = false;
    $('#previewControls').hidden = false;
    $('#pdfStage').dataset.stale = stale ? '1' : '0';
    // 编译失败但手里还是同一版 PDF（stale）时不必重拉：重新加载会让预览白屏一下
    loadPdf(state.pdfUrl, { keep: (keepPdf || stale) && Boolean(pdfDocument), token: pdfToken });
  } else {
    $('#previewCaption').textContent = '尚未编译';
    $('#previewActions').hidden = true;
    $('#previewControls').hidden = true;
    $('#pdfStage').dataset.stale = '0';
    unloadPdfDocument();
    $('#pdfStage').innerHTML = '<div class="preview-empty"><div class="preview-paper"><span></span><span></span><span></span><span></span></div><h2>预览你的论文</h2><p>选择主文件并点击“编译 PDF”（或选中片段按 ⌘L 极速预览）。</p></div>';
  }
}

// 换文档 / 编译失败清空预览时彻底回收：取消观察器与在途渲染、卸画布、destroy 文档与 worker
function unloadPdfDocument() {
  cleanupPdfObserver();
  const stage = $('#pdfStage');
  if (stage) {
    for (const wrap of stage.querySelectorAll('.pdf-page-wrap')) releasePdfCanvas(wrap, { placeholder: false });
  }
  pdfDocument = null;
  pdfLoadedUrl = null;
  pdfLoadedToken = null;
  pdfCanvasPages = new Set();
  pdfCanvasBytes = 0;
  pdfFirstPageTop = 0;
  pdfPageStride = 0;
  pdfPage = 1;
}

// 在屏画布上限：A4 @ scale×2 单页 rgba 可达几十 MB，几百页连续滚动必须回收
const PDF_MAX_LIVE_CANVASES = 8;
// 同时最多 2 页在渲染：⌘⇧G 连点翻页时不至于把几十页排进 worker 队列
const PDF_RENDER_CONCURRENCY = 2;
// 无 SyncTeX 记录时的文本近似：懒加载下每页都要取分段，只在有限页内找
const PDF_TEXT_SCAN_LIMIT = 40;
let pdfRenderActive = 0;
const pdfRenderWaiters = [];

function acquirePdfRenderSlot() {
  if (pdfRenderActive < PDF_RENDER_CONCURRENCY) {
    pdfRenderActive++;
    return Promise.resolve();
  }
  return new Promise(resolve => pdfRenderWaiters.push(resolve));
}

function releasePdfRenderSlot() {
  const next = pdfRenderWaiters.shift();
  if (next) next();
  else pdfRenderActive--;
}

function cleanupPdfObserver() {
  if (pdfPageObserver) {
    pdfPageObserver.disconnect();
    pdfPageObserver = null;
  }
  for (const task of pdfRenderTasks.values()) {
    try { task.cancel(); } catch {}
  }
  pdfRenderTasks.clear();
}

// 离屏页回收：把画布摘下来并把尺寸置 0 释放位图内存，wrap 保留占位高度、复位 rendered，
// 滚回来 IntersectionObserver 会重新画（否则空页数组会一直挂着）
function releasePdfCanvas(wrap, { placeholder = true } = {}) {
  if (!wrap) return;
  const page = Number(wrap.dataset.page);
  if (page) pdfCanvasPages.delete(page);
  const canvas = wrap.querySelector('canvas.pdf-canvas');
  if (canvas) {
    pdfCanvasBytes = Math.max(0, pdfCanvasBytes - canvas.width * canvas.height * 4);
    wrap.removeChild(canvas);
    canvas.width = 0;
    canvas.height = 0;
  }
  if (wrap.dataset.rendered === '1') {
    delete wrap.dataset.rendered;
    if (placeholder && !wrap.querySelector('.pdf-page-placeholder')) {
      const ph = document.createElement('span');
      ph.className = 'pdf-page-placeholder';
      ph.textContent = `第 ${page} 页`;
      wrap.prepend(ph);
    }
  }
}

// 在屏画布超过上限时，按离当前页的远近回收最远的几页
function enforcePdfCanvasBudget(stage, activePage) {
  if (pdfCanvasPages.size <= PDF_MAX_LIVE_CANVASES) return;
  const rendered = Array.from(stage.querySelectorAll('.pdf-page-wrap[data-rendered="1"]'));
  if (rendered.length <= PDF_MAX_LIVE_CANVASES) return;
  const activeIndex = rendered.findIndex(wrap => Number(wrap.dataset.page) === activePage);
  const ordered = rendered
    .map((wrap, index) => ({ wrap, distance: activeIndex < 0 ? index : Math.abs(index - activeIndex) }))
    .sort((a, b) => a.distance - b.distance);
  for (const item of ordered.slice(PDF_MAX_LIVE_CANVASES)) {
    releasePdfCanvas(item.wrap);
    if (pdfCanvasPages.size <= PDF_MAX_LIVE_CANVASES) break;
  }
}

async function loadPdf(url, { keep = false, token = null } = {}) {
  if (!url) return;
  const generation = ++pdfGeneration;
  const stage = $('#pdfStage');
  if (keep && pdfDocument && token && token === pdfLoadedToken && pdfLoadedUrl === url) {
    // 服务端内容指纹一致：PDF 没变，只按当前宽度补一次布局，不重新取文件也不闪屏
    await renderPdfView(generation, { preserveScroll: true });
    return;
  }
  const isFirstLoad = !pdfDocument;
  if (isFirstLoad) stage.innerHTML = '<div class="pdf-loading">正在渲染 PDF…</div>';
  let nextDoc = null;
  try {
    // 服务端 sendFile 已支持 Range/ETag：disableAutoFetch 让 100+ 页论文只按需取用到的分段，
    // 不再每次编译都整份下载
    nextDoc = await getDocument({ url, disableAutoFetch: true }).promise;
  } catch (error) {
    if (generation !== pdfGeneration) {
      try { nextDoc?.destroy(); } catch {}
      return;
    }
    // 取不到新 PDF：清掉旧文档并明确提示，不能把上一版继续挂在预览里
    unloadPdfDocument();
    stage.innerHTML = '<div class="pdf-loading">预览渲染失败，请点右上角“打开”查看 PDF。</div>';
    notify(`PDF 预览失败：${error.message}`, 'error');
    return;
  }
  if (generation !== pdfGeneration) {
    // 已经有更新的编译在路上了：这份刚取到的文档必须销毁，不能漏 worker 和位图内存
    try { nextDoc.destroy(); } catch {}
    return;
  }
  if (pdfDocument) {
    try { pdfDocument.destroy(); } catch {}
  }
  pdfDocument = nextDoc;
  pdfLoadedUrl = url;
  pdfLoadedToken = token || `url:${url}`;
  pdfCanvasPages = new Set();
  pdfCanvasBytes = 0;
  // 页号属于上一个文档，不带进新文档（用 Math.min 夹一下反而会停在错误页）
  pdfPage = 1;
  updatePdfToolbarControls();
  try {
    await renderPdfView(generation, { preserveScroll: false });
  } catch (error) {
    if (generation !== pdfGeneration) return;
    stage.innerHTML = '<div class="pdf-loading">预览渲染失败，请点右上角“打开”查看 PDF。</div>';
    notify(`PDF 预览失败：${error.message}`, 'error');
  }
}

function updatePdfToolbarControls() {
  if (!pdfDocument) return;
  const input = $('#pageInput');
  if (document.activeElement !== input) input.value = String(pdfPage);
  input.max = String(pdfDocument.numPages);
  $('#pageTotal').textContent = String(pdfDocument.numPages);
  $('#previousPage').disabled = pdfPage <= 1;
  $('#nextPage').disabled = pdfPage >= pdfDocument.numPages;
  const zoomText = state.pdfFitMode === 'page' && pdfZoom === 1 ? '整页' : `${Math.round((Number(pdfZoom) || 1) * 100)}%`;
  $('#zoomReset').textContent = zoomText;
  $('#togglePdfMode').textContent = state.pdfScrollMode === 'continuous' ? '滚动' : '单页';
}

async function renderCanvasIntoWrap(wrap, pageNumber, generation) {
  if (!pdfDocument || generation !== pdfGeneration) return;
  if (wrap.dataset.rendering === '1') return;
  if (wrap.dataset.rendered === '1') return;
  wrap.dataset.rendering = '1';
  await acquirePdfRenderSlot();
  try {
    if (generation !== pdfGeneration) return;
    const page = await pdfDocument.getPage(pageNumber);
    if (generation !== pdfGeneration) return;
    const targetScale = Number(wrap.dataset.scale) || 1;
    const viewport = page.getViewport({ scale: targetScale });
    const baseViewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.setAttribute('aria-label', `PDF 第 ${pageNumber} 页`);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext('2d');
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const task = page.render({ canvasContext: context, viewport });
    pdfRenderTasks.set(pageNumber, task);
    try {
      await task.promise;
    } finally {
      pdfRenderTasks.delete(pageNumber);
    }
    if (generation !== pdfGeneration) return;

    // 换页内容时把旧画布也置 0 释放，不要只扔掉引用等 GC
    const previousCanvas = wrap.querySelector('canvas.pdf-canvas');
    if (previousCanvas && previousCanvas !== canvas) releasePdfCanvas(wrap, { placeholder: false });
    const existingHighlight = wrap.querySelector('.pdf-sync-highlight');
    const badge = document.createElement('span');
    badge.className = 'pdf-page-badge';
    badge.textContent = `第 ${pageNumber} / ${pdfDocument.numPages} 页`;
    wrap.replaceChildren(canvas, badge);
    if (existingHighlight) wrap.append(existingHighlight);
    wrap.dataset.rendered = '1';
    // 记住 1:1 的页尺寸，双向定位换算高亮框时按 viewport 比例而不是拍脑袋的 px
    wrap.dataset.bw = String(baseViewport.width);
    wrap.dataset.bh = String(baseViewport.height);
    pdfCanvasPages.add(pageNumber);
    pdfCanvasBytes += canvas.width * canvas.height * 4;
    enforcePdfCanvasBudget($('#pdfStage'), pdfPage);
  } catch (error) {
    // 渲染被取消（换文档 / 快速滚动）是正常路径，其它错误要让用户看到
    if (error?.name !== 'RenderingCancelledException') {
      console.warn(`[砚台] PDF 第 ${pageNumber} 页渲染失败`, error);
    }
  } finally {
    releasePdfRenderSlot();
    wrap.dataset.rendering = '0';
  }
}

// 每 bp（1/72 英寸）对应多少 CSS px：按当前 wrap 的实际尺寸算，缩放/适应整页都不会错位
function pdfUnitPerBp(wrap) {
  const baseWidth = Number(wrap.dataset.bw) || 0;
  const baseHeight = Number(wrap.dataset.bh) || 0;
  const width = wrap.clientWidth || Number(wrap.style.width.replace('px', '')) || 1;
  const height = wrap.clientHeight || Number(wrap.style.height.replace('px', '')) || 1;
  if (!baseWidth || !baseHeight) {
    const fallback = Number(wrap.dataset.scale) || 1;
    return { ux: fallback, uy: fallback };
  }
  return { ux: width / baseWidth, uy: height / baseHeight };
}

function showPdfSyncHighlight(wrap, boxBp) {
  if (!wrap || !boxBp) return;
  wrap.querySelectorAll('.pdf-sync-highlight').forEach(el => el.remove());
  const { ux, uy } = pdfUnitPerBp(wrap);
  const boxWidth = wrap.clientWidth || 1;
  const boxHeight = wrap.clientHeight || 1;
  // SyncTeX 的 y 是页顶往上的 bp，乘每 bp 的 CSS px 而不是直接当 px 用；再夹进页面框内
  const left = Math.min(Math.max(2, Math.floor((boxBp.x - 4) * ux)), Math.max(2, boxWidth - 40));
  const top = Math.min(Math.max(2, Math.floor((boxBp.y - 3) * uy)), Math.max(2, boxHeight - 16));
  const width = Math.min(Math.max(40, Math.ceil((boxBp.width + 8) * ux)), boxWidth - left - 2);
  const height = Math.min(Math.max(14, Math.ceil((boxBp.height + 6) * uy)), boxHeight - top - 2);
  const marker = document.createElement('div');
  marker.className = 'pdf-sync-highlight';
  marker.style.left = `${left}px`;
  marker.style.top = `${top}px`;
  marker.style.width = `${Math.max(10, width)}px`;
  marker.style.height = `${Math.max(8, height)}px`;
  wrap.append(marker);
  setTimeout(() => marker.remove(), 2200);
}

async function syncCursorToPdf() {
  if (!state.activeFile?.endsWith('.tex')) {
    notify('请先打开 .tex 文件再定位 PDF', 'info');
    return;
  }
  if (!state.rootFile) {
    notify('请先选择主文件并编译 PDF', 'error');
    return;
  }
  showTab('preview');
  if (state.result?.snippet && state.fullCompileBackup?.pdfUrl) {
    state.result = state.fullCompileBackup.result;
    state.pdfUrl = state.fullCompileBackup.pdfUrl;
    state.pdfFingerprint = state.fullCompileBackup.pdfFingerprint;
    state.fullCompileBackup = null;
    // renderResult 里按「来源 + 指纹」决定是否重载，选段 → 全文一定会换文档
    renderResult({ keepPdf: true });
  } else if (!state.pdfUrl || state.result?.snippet) {
    await compile({ silentSuccess: true });
  }
  if (!pdfDocument) {
    notify('PDF 还没准备好，先编译一次再定位', 'info');
    return;
  }

  const cursorLine = editor.state.doc.lineAt(editor.state.selection.main.head).number;
  try {
    const sync = await send('/api/synctex/forward', 'POST', {
      rootFile: state.rootFile,
      file: state.activeFile,
      line: cursorLine
    });
    if (sync?.found && sync.page >= 1 && sync.page <= pdfDocument.numPages) {
      pdfPage = sync.page;
      updatePdfToolbarControls();
      if (state.pdfScrollMode === 'single') {
        await renderPdfView(pdfGeneration, { preserveScroll: false });
      }
      const stage = $('#pdfStage');
      const wrap = stage.querySelector(`.pdf-page-wrap[data-page="${sync.page}"]`);
      if (wrap) {
        await renderCanvasIntoWrap(wrap, sync.page, pdfGeneration);
        if (state.pdfScrollMode === 'continuous') {
          const { uy } = pdfUnitPerBp(wrap);
          const targetTop = wrap.offsetTop + sync.y * uy - stage.clientHeight * 0.35;
          stage.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
        }
        showPdfSyncHighlight(wrap, sync);
        notify(`已定位到 PDF 第 ${sync.page} 页`);
        return;
      }
    }
  } catch (error) {
    console.warn('[砚台] SyncTeX 正向定位失败，改用文本近似', error);
  }

  // Fallback: approximate text search across PDF pages if SyncTeX has no entry (e.g. blank/preamble line)
  const doc = editor.state.doc;
  let snippet = '';
  for (let delta = 0; delta <= 6 && !snippet; delta++) {
    for (const candidateLine of [cursorLine - delta, cursorLine + delta]) {
      if (candidateLine < 1 || candidateLine > doc.lines) continue;
      const cleaned = doc.line(candidateLine).text
        .replace(/(?<!\\)%.*/, '')
        .replace(/\\[a-zA-Z@*]+|\{|\}|\$/g, '')
        .replace(/\s+/g, '')
        .slice(0, 12);
      if (cleaned.length >= 3) { snippet = cleaned; break; }
    }
  }
  if (!snippet) {
    notify('该行属于导言区或尚未编译进正文，重新编译后再试', 'info');
    return;
  }
  // 按页取文本会触发分段下载：只在当前页附近有限页内近似，不整本翻完
  const order = [];
  for (let delta = 0; order.length < pdfDocument.numPages && order.length < PDF_TEXT_SCAN_LIMIT; delta++) {
    for (const candidatePage of [pdfPage - delta, pdfPage + delta]) {
      if (candidatePage >= 1 && candidatePage <= pdfDocument.numPages && !order.includes(candidatePage)) {
        order.push(candidatePage);
        if (order.length >= PDF_TEXT_SCAN_LIMIT) break;
      }
      if (pdfPage - delta < 1 && pdfPage + delta > pdfDocument.numPages) break;
    }
  }
  order.sort((a, b) => a - b);
  for (const p of order) {
    try {
      const page = await pdfDocument.getPage(p);
      const tc = await page.getTextContent();
      const joined = tc.items.map(i => i.str || '').join('').replace(/\s+/g, '');
      page.cleanup();
      if (joined.includes(snippet) || (snippet.length >= 6 && joined.includes(snippet.slice(0, 6)))) {
        goToPdfPage(p);
        notify(`已近似定位到 PDF 第 ${p} 页`);
        return;
      }
    } catch (error) {
      console.warn(`[砚台] PDF 第 ${p} 页文本提取失败`, error);
    }
  }
  notify(
    pdfDocument.numPages > PDF_TEXT_SCAN_LIMIT
      ? `该行没有 SyncTeX 记录，已在附近 ${PDF_TEXT_SCAN_LIMIT} 页内做过文本近似但未命中`
      : '该行属于导言区或尚未编译进正文，重新编译后再试',
    'info'
  );
}

// 双击 PDF 兜底定位要把章节文件全读一遍：内容按 30s 缓存复用、并发受限、总量封顶，
// 否则 100+ 页论文首次定位就是一串几百个串行请求
const LOCATE_CACHE_TTL_MS = 30_000;
const LOCATE_CONCURRENCY = 6;
const LOCATE_FILE_LIMIT = 80;
const LOCATE_CACHE_BUDGET = 24 * 1024 * 1024;
const locateFileCache = new Map();
let locateInProgress = false;

function locateCacheSize() {
  let total = 0;
  for (const entry of locateFileCache.values()) total += entry.size;
  return total;
}

async function readProjectTextForLocate(filePath) {
  if (filePath === state.activeFile) return editor.state.doc.toString();
  const hit = locateFileCache.get(filePath);
  if (hit && Date.now() - hit.at < LOCATE_CACHE_TTL_MS) return hit.content;
  const data = await request(`/api/file?path=${encodeURIComponent(filePath)}`);
  const content = typeof data.content === 'string' ? data.content : '';
  if (content.length > 4 * 1024 * 1024) throw new Error('文件超过 4MB，已跳过');
  if (locateCacheSize() + content.length > LOCATE_CACHE_BUDGET) locateFileCache.clear();
  locateFileCache.set(filePath, { at: Date.now(), size: content.length, content });
  return content;
}

function stripLineForLocate(line) {
  return line
    .replace(/(?<!\\)%.*/, '')
    .replace(/\\[a-zA-Z@*]+|\{|\}/g, '')
    .replace(/\s+/g, '');
}

async function locateSourceFromPdfClick(pageNumber, xRatio, yRatio) {
  if (!pdfDocument || !state.projectRoot) return;
  if (locateInProgress) return;
  locateInProgress = true;
  try {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const clampedX = Math.max(0, Math.min(1, xRatio));
    const clampedY = Math.max(0, Math.min(1, yRatio));

    if (!state.result?.snippet && state.rootFile) {
      try {
        const reverse = await send('/api/synctex/reverse', 'POST', {
          rootFile: state.rootFile,
          page: pageNumber,
          x: clampedX * viewport.width,
          y: clampedY * viewport.height
        });
        if (reverse?.found && reverse.file && state.files.some(f => f.path === reverse.file)) {
          await openFile(reverse.file, reverse.line);
          notify(`已精准定位到 ${reverse.file} 第 ${reverse.line} 行`);
          return;
        }
      } catch (error) {
        console.warn('[砚台] SyncTeX 反向定位失败，改用文本近似', error);
      }
    }

    const targetPdfY = (1 - clampedY) * viewport.height;
    const textContent = await page.getTextContent();
    const rows = new Map();
    for (const item of textContent.items) {
      const str = (item.str || '').trim();
      if (!str) continue;
      const y = Math.round((item.transform?.[5] || 0) / 6) * 6;
      rows.set(y, ((rows.get(y) || '') + ' ' + str).trim());
    }
    const candidates = Array.from(rows.entries())
      .map(([y, text]) => ({ y, text, dist: Math.abs(y - targetPdfY) }))
      .filter(row => row.text.length >= 2)
      .sort((a, b) => a.dist - b.dist)
      .map(row => ({
        ...row,
        key: row.text.replace(/^\d+(?:\.\d+)*\s*/, '').replace(/\s+/g, '').slice(0, 18)
      }))
      .filter(row => row.key.length >= 2)
      .slice(0, 4);

    if (!candidates.length) {
      notify('这一行没有 SyncTeX 记录，也没能从 PDF 里提取到可匹配的文本', 'info');
      return;
    }

    const searchFiles = Array.from(new Set([
      ...(state.activeFile?.endsWith('.tex') ? [state.activeFile] : []),
      ...state.files.filter(f => f.path.endsWith('.tex')).map(f => f.path)
    ])).slice(0, LOCATE_FILE_LIMIT);

    notify(`正在 ${searchFiles.length} 个 .tex 文件里近似定位…`, 'info');
    // 先并发（受限）把文件读齐，再按候选优先级做纯字符串匹配，语义与逐个串行一致
    const contents = new Map();
    let failures = 0;
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < searchFiles.length) {
        const filePath = searchFiles[nextIndex++];
        try {
          contents.set(filePath, await readProjectTextForLocate(filePath));
        } catch (error) {
          failures++;
          console.warn(`[砚台] 定位时读取 ${filePath} 失败`, error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOCATE_CONCURRENCY, searchFiles.length) }, worker));

    for (const candidate of candidates) {
      const key = candidate.key;
      const shortKey = key.length >= 6 ? key.slice(0, 6) : '';
      for (const [filePath, content] of contents) {
        const lines = content.split('\n');
        for (let idx = 0; idx < lines.length; idx++) {
          const stripped = stripLineForLocate(lines[idx]);
          if (stripped && (stripped.includes(key) || (shortKey && stripped.includes(shortKey)))) {
            await openFile(filePath, idx + 1);
            notify(`已定位到 ${filePath} 第 ${idx + 1} 行${failures ? `（${failures} 个文件读取失败已跳过）` : ''}`);
            return;
          }
        }
      }
    }

    if (failures) notify(`有 ${failures} 个文件读取失败，可能漏掉了匹配位置（详见控制台）`, 'error');
    else notify('没有在源码里匹配到这段文本（可能是图表自动生成内容，或排版把一行拆开了）', 'info');
  } catch (error) {
    notify(`反向定位失败：${error.message}`, 'error');
  } finally {
    locateInProgress = false;
  }
}

async function renderPdfView(generation = ++pdfGeneration, { preserveScroll = true } = {}) {
  if (!pdfDocument) return;
  cleanupPdfObserver();

  const stage = $('#pdfStage');
  const prevScrollTop = stage.scrollTop;
  const prevScrollHeight = stage.scrollHeight;
  const prevClientHeight = stage.clientHeight;
  const stageWidth = Math.max(240, stage.clientWidth - 40);
  const stageHeight = Math.max(240, stage.clientHeight - 44);

  const firstPage = await pdfDocument.getPage(1);
  if (generation !== pdfGeneration) return;
  const baseViewport = firstPage.getViewport({ scale: 1 });
  const fitScale = state.pdfFitMode === 'page'
    ? Math.min(stageWidth / baseViewport.width, stageHeight / baseViewport.height)
    : stageWidth / baseViewport.width;
  const scale = fitScale * pdfZoom;
  const pageWidth = Math.floor(baseViewport.width * scale);
  const pageHeight = Math.floor(baseViewport.height * scale);

  updatePdfToolbarControls();

  const pagesToCreate = state.pdfScrollMode === 'continuous'
    ? Array.from({ length: pdfDocument.numPages }, (_, idx) => idx + 1)
    : [pdfPage];

  const fragment = document.createDocumentFragment();
  const wraps = [];

  for (const num of pagesToCreate) {
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.dataset.page = String(num);
    wrap.dataset.scale = String(scale);
    // 1:1 页尺寸留着做双向定位换算；wrap 宽高与 canvas 的 CSS 尺寸一致，不会留大片空白
    wrap.dataset.bw = String(baseViewport.width);
    wrap.dataset.bh = String(baseViewport.height);
    wrap.style.width = `${pageWidth}px`;
    wrap.style.height = `${pageHeight}px`;
    wrap.title = '双击页面任意位置可反向定位到 LaTeX 源码行';
    const placeholder = document.createElement('span');
    placeholder.className = 'pdf-page-placeholder';
    placeholder.textContent = `第 ${num} 页`;
    const badge = document.createElement('span');
    badge.className = 'pdf-page-badge';
    badge.textContent = `第 ${num} / ${pdfDocument.numPages} 页`;
    wrap.append(placeholder, badge);
    wrap.addEventListener('dblclick', event => {
      const rect = wrap.getBoundingClientRect();
      const xRatio = (event.clientX - rect.left) / Math.max(1, rect.width);
      const yRatio = (event.clientY - rect.top) / Math.max(1, rect.height);
      locateSourceFromPdfClick(num, xRatio, yRatio);
    });
    fragment.append(wrap);
    wraps.push({ num, wrap });
  }

  // 重建前先释放旧的一屏画布（换缩放 / 换模式 / 侧栏折叠都会走到这里）
  for (const old of stage.querySelectorAll('.pdf-page-wrap')) releasePdfCanvas(old, { placeholder: false });
  pdfCanvasPages = new Set();
  pdfCanvasBytes = 0;

  // Eagerly render the active page (and adjacent page) BEFORE swapping DOM to prevent any white flash
  const eagerPages = new Set([pdfPage, Math.max(1, pdfPage - 1), Math.min(pdfDocument.numPages, pdfPage + 1)]);
  await Promise.all(
    wraps
      .filter(item => eagerPages.has(item.num))
      .map(item => renderCanvasIntoWrap(item.wrap, item.num, generation))
  );
  if (generation !== pdfGeneration) return;

  stage.replaceChildren(fragment);

  // 连续模式下页高等距：记下步长，滚动时 O(1) 反推当前页，不再每帧遍历几百个 wrap
  if (state.pdfScrollMode === 'continuous' && wraps.length) {
    pdfFirstPageTop = wraps[0].wrap.offsetTop;
    pdfPageStride = wraps.length > 1 ? wraps[1].wrap.offsetTop - wraps[0].wrap.offsetTop : pageHeight + 18;
  } else {
    pdfFirstPageTop = 0;
    pdfPageStride = 0;
  }

  if (preserveScroll && state.pdfScrollMode === 'continuous' && prevScrollHeight > 0) {
    if (Math.abs(stage.scrollHeight - prevScrollHeight) <= 6) {
      stage.scrollTop = prevScrollTop;
    } else {
      const centerRatio = (prevScrollTop + prevClientHeight * 0.38) / prevScrollHeight;
      stage.scrollTop = Math.max(0, Math.round(centerRatio * stage.scrollHeight - stage.clientHeight * 0.38));
    }
  }

  if (state.pdfScrollMode === 'continuous' && 'IntersectionObserver' in window) {
    pdfPageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const wrap = entry.target;
        const num = Number(wrap.dataset.page);
        if (!num) continue;
        if (entry.isIntersecting) {
          renderCanvasIntoWrap(wrap, num, generation);
        } else if (pdfCanvasPages.size > PDF_MAX_LIVE_CANVASES) {
          // 离屏超过 700px 缓冲的页直接回收位图，滚回来会重新画；几百页连续滚动不再只增不减
          releasePdfCanvas(wrap);
        }
      }
    }, { root: stage, rootMargin: '700px 0px' });

    for (const item of wraps) {
      pdfPageObserver.observe(item.wrap);
    }
  } else {
    for (const item of wraps) {
      renderCanvasIntoWrap(item.wrap, item.num, generation);
    }
  }
}

function goToPdfPage(targetPage) {
  if (!pdfDocument) return;
  pdfPage = Math.max(1, Math.min(pdfDocument.numPages, Number(targetPage) || 1));
  updatePdfToolbarControls();
  if (state.pdfScrollMode === 'continuous') {
    const stage = $('#pdfStage');
    const pageEl = stage.querySelector(`.pdf-page-wrap[data-page="${pdfPage}"]`);
    if (pageEl) {
      renderCanvasIntoWrap(pageEl, pdfPage, pdfGeneration);
      // 平滑滚动期间别让 scroll 回调反写页码：动画落点会被算成上一页
      pdfProgrammaticScrollUntil = Date.now() + 700;
      stage.scrollTo({ top: Math.max(0, pageEl.offsetTop - 16), behavior: 'smooth' });
    }
  } else {
    renderPdfView(pdfGeneration, { preserveScroll: false });
  }
}

function insertSnippet(template) {
  if (!state.activeFile?.endsWith('.tex')) { notify('请先打开 .tex 文件', 'error'); return; }
  const marker = '▯';
  const position = template.indexOf(marker);
  const text = template.replace(marker, '');
  const range = editor.state.selection.main;
  const cursor = range.from + (position >= 0 ? position : text.length);
  editor.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: cursor }, scrollIntoView: true });
  editor.focus();
}

function selectionText() { const range = editor.state.selection.main; return editor.state.doc.sliceString(range.from, range.to); }

function quickSnippet(name) {
  const selected = selectionText();
  const snippets = {
    section: `\n\\section{${selected || '▯'}}\n`,
    subsection: `\n\\subsection{${selected || '▯'}}\n`,
    bold: `\\textbf{${selected || '▯'}}`,
    italic: `\\textit{${selected || '▯'}}`,
    inlineMath: `$${selected || '▯'}$`,
    math: `\n\\begin{equation}\n  ${selected || '▯'}\n\\end{equation}\n`,
    itemize: `\n\\begin{itemize}\n  \\item ${selected || '▯'}\n\\end{itemize}\n`,
    enumerate: `\n\\begin{enumerate}\n  \\item ${selected || '▯'}\n\\end{enumerate}\n`,
    figure: `\n\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{▯}\n  \\caption{图片标题}\n  \\label{fig:sample}\n\\end{figure}\n`,
    cite: '\\cite{▯}'
  };
  const template = snippets[name];
  if (template == null) return;
  // Wrapping a selection keeps it selected, so ⌘B then ⌘I nests instead of dropping the text.
  const marker = template.indexOf('▯');
  if (selected && marker >= 0 && template.includes(selected)) {
    const text = template.replace(marker, '');
    const from = editor.state.selection.main.from;
    editor.dispatch({
      changes: { from, to: editor.state.selection.main.to, insert: text },
      selection: { anchor: from + marker, head: from + marker + selected.length },
      scrollIntoView: true
    });
    editor.focus();
    return;
  }
  insertSnippet(template);
}

function renderMathPalette() {
  const palette = $('#mathPalette');
  if (!palette) return;
  document.querySelectorAll('[data-math-cat]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mathCat === state.mathCat);
  });
  palette.replaceChildren();
  const list = mathCategories[state.mathCat] || mathCategories.common;
  for (const item of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.tex = item.tex;
    btn.title = `${item.title} (${item.tex.replace(/\s+/g, ' ')})`;
    // 按钮上的字形（a/b、∑）是装饰性写法，读屏要念的是中文说明
    btn.setAttribute('aria-label', `插入${item.title} ${item.tex.replace(/\s+/g, ' ')}`);
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = item.label;
    btn.append(glyph);
    palette.append(btn);
  }
}

function parseDelimitedTable(rawText) {
  if (!rawText || !rawText.trim()) return null;
  const rawLines = rawText.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim().length > 0);
  if (!rawLines.length) return null;

  // Support Markdown tables, Excel/Numbers TSV, and CSV
  const isMarkdown = rawLines.every(line => line.includes('|'));
  let rows;
  if (isMarkdown) {
    rows = rawLines
      .filter(line => !/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line))
      .map(line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
  } else if (rawLines.some(line => line.includes('\t'))) {
    rows = rawLines.map(line => line.split('\t').map(cell => cell.trim()));
  } else if (rawLines.length > 1 || rawLines[0].includes(',')) {
    rows = rawLines.map(line => line.split(',').map(cell => cell.trim()));
  } else {
    return null;
  }
  if (!rows.length) return null;
  const maxCols = Math.max(...rows.map(r => r.length));
  if (rows.length === 1 && maxCols <= 1) return null;
  return {
    rows: rows.slice(0, 30).map(r => r.slice(0, 12)),
    rowCount: Math.min(30, rows.length),
    colCount: Math.min(12, Math.max(1, maxCols))
  };
}

function applyParsedTable(parsed) {
  if (!parsed) {
    notify('未识别到多列或多行表格数据（支持从 Excel、Numbers、CSV 或 Markdown 表格复制）', 'info');
    return false;
  }
  tableData = parsed.rows.map(row => Array.from({ length: parsed.colCount }, (_, c) => row[c] || ''));
  $('#tableRows').value = String(parsed.rowCount);
  $('#tableCols').value = String(parsed.colCount);
  drawTableGrid();
  notify(`已填充 ${parsed.rowCount} 行 × ${parsed.colCount} 列数据`, 'success');
  return true;
}

function drawTableGrid() {
  const rows = Math.max(1, Math.min(30, Number($('#tableRows').value) || 1));
  const cols = Math.max(1, Math.min(12, Number($('#tableCols').value) || 1));
  $('#tableRows').value = rows; $('#tableCols').value = cols;
  const grid = $('#tableGrid'); grid.replaceChildren(); grid.style.gridTemplateColumns = `repeat(${cols}, minmax(68px, 1fr))`;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const input = document.createElement('input');
      input.placeholder = r === 0 ? `表头 ${c + 1}` : `${r + 1},${c + 1}`;
      input.value = tableData[r]?.[c] || '';
      input.addEventListener('input', () => { tableData[r] ||= []; tableData[r][c] = input.value; });
      input.addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text/plain') || '';
        if (text.includes('\t') || text.includes('\n') || text.includes('|')) {
          const parsed = parseDelimitedTable(text);
          if (parsed) {
            event.preventDefault();
            applyParsedTable(parsed);
          }
        }
      });
      grid.append(input);
    }
  }
}

function insertEquation() {
  const content = $('#equationInput').value.trim() || selectionText() || '▯';
  const label = $('#equationLabel').value.trim();
  const mode = $('#equationMode').value;
  if (mode === 'inline') insertSnippet(`$${content}$`);
  else if (mode === 'display') insertSnippet(`\n\\[\n  ${content}\n\\]\n`);
  else if (mode === 'align') insertSnippet(`\n\\begin{align}\n  ${content}${label ? ` \\label{${label}}` : ''}\n\\end{align}\n`);
  else insertSnippet(`\n\\begin{equation}\n  ${content}${label ? `\n  \\label{${label}}` : ''}\n\\end{equation}\n`);
}

function insertMathContentDirect() {
  const content = $('#equationInput').value.trim();
  if (!content) { notify('请先在上方公式框输入或点选符号', 'info'); return; }
  insertSnippet(content);
}

function ensureBooktabsPackage() {
  if (!state.activeFile?.endsWith('.tex')) return;
  const text = editor.state.doc.toString();
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\bbooktabs\b[^}]*\}/.test(text)) return;
  const docClassMatch = text.match(/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}\r?\n?/);
  if (docClassMatch) {
    const insertPos = docClassMatch.index + docClassMatch[0].length;
    editor.dispatch({ changes: { from: insertPos, to: insertPos, insert: '\\usepackage{booktabs}\n' } });
  }
}

function insertTable() {
  const rows = Number($('#tableRows').value), cols = Number($('#tableCols').value);
  const style = $('#tableStyle').value;
  const alignChar = $('#tableAlign').value || 'c';
  const caption = $('#tableCaption').value.trim();
  const label = $('#tableLabel').value.trim();

  if (style === 'booktabs') {
    ensureBooktabsPackage();
    const headerRow = Array.from({ length: cols }, (_, c) => tableData[0]?.[c] || `指标 ${c + 1}`).join(' & ') + ' \\\\';
    const dataRows = Array.from({ length: Math.max(1, rows - 1) }, (_, idx) => {
      const r = idx + 1;
      return '    ' + Array.from({ length: cols }, (_, c) => tableData[r]?.[c] || ' ').join(' & ') + ' \\\\';
    }).join('\n');
    insertSnippet(
      `\n\\begin{table}[htbp]\n  \\centering\n${caption ? `  \\caption{${caption}}\n` : ''}${label ? `  \\label{${label}}\n` : ''}  \\begin{tabular}{${alignChar.repeat(cols)}}\n    \\toprule\n    ${headerRow}\n    \\midrule\n${dataRows}\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n`
    );
  } else {
    const body = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => tableData[r]?.[c] || ' ').join(' & ') + ' \\\\ \\hline').join('\n');
    insertSnippet(`\n\\begin{table}[htbp]\n  \\centering\n${caption ? `  \\caption{${caption}}\n` : ''}${label ? `  \\label{${label}}\n` : ''}  \\begin{tabular}{|${`${alignChar}|`.repeat(cols)}}\n    \\hline\n${body.split('\n').map(line => '    ' + line).join('\n')}\n  \\end{tabular}\n\\end{table}\n`);
  }
}

function insertImage() {
  const file = $('#imageSelect').value;
  if (!file) { notify('请先选择或导入图片', 'error'); return; }
  const caption = $('#imageCaption').value.trim();
  const label = $('#imageLabel').value.trim();
  const width = $('#imageWidth').value;
  insertSnippet(`\n\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=${width}\\linewidth]{${file}}\n${caption ? `  \\caption{${caption}}\n` : ''}${label ? `  \\label{${label}}\n` : ''}\\end{figure}\n`);
}

function figureSnippet(path) {
  const stem = path.split('/').pop().replace(/\.[^.]+$/, '');
  return `\n\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${path}}\n  \\caption{${stem || '▯'}}\n  \\label{fig:${stem || 'image'}}\n\\end{figure}\n`;
}

// 内容指纹（FNV-1a 取样首尾）：连按 ⌘V 粘贴同一张图时不再堆 paste-…-2 副本
function imageContentFingerprint(buffer, size) {
  const bytes = new Uint8Array(buffer);
  const head = bytes.subarray(0, 65536);
  const tail = bytes.subarray(Math.max(0, bytes.length - 8192));
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < head.length; i++) { h1 ^= head[i]; h1 = Math.imul(h1, 0x01000193) >>> 0; }
  for (let i = 0; i < tail.length; i++) { h2 ^= tail[i]; h2 = Math.imul(h2, 0x01000193) >>> 0; }
  return `${size}:${h1.toString(36)}:${h2.toString(36)}`;
}

function pruneRecentPastes() {
  const now = Date.now();
  for (const [key, entry] of recentPastedImages) {
    if (entry.at < now - RECENT_PASTE_TTL_MS) recentPastedImages.delete(key);
  }
}

// 粘贴 / 拖拽进入编辑器的图片：同一张图两分钟内重复出现就直接复用已导入的那份
async function importPastedImage(file) {
  if (!state.projectRoot) { notify('请先打开项目', 'error'); return; }
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    notify(`读取图片失败：${error.message}`, 'error');
    return;
  }
  const fingerprint = imageContentFingerprint(buffer, file.size);
  pruneRecentPastes();
  const known = recentPastedImages.get(fingerprint)?.path;
  if (known && state.files.some(item => item.path === known)) {
    if (state.activeFile?.endsWith('.tex')) insertSnippet(figureSnippet(known));
    notify(`这张图刚刚导入过，已复用 ${known}（没有重复存盘）`, 'info');
    return;
  }
  await uploadImage(file, { autoInsert: true, buffer, fingerprint });
}

async function uploadImage(file, { autoInsert = false, buffer = null, fingerprint = null } = {}) {
  if (!state.projectRoot) { notify('请先打开项目', 'error'); return; }
  try {
    const response = await fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer ?? await file.arrayBuffer(),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '导入失败');
    state.files = (await request('/api/tree')).files;
    renderTree(); renderImagePicker();
    $('#imageSelect').value = data.path;
    updateImageThumb();
    if (fingerprint) recentPastedImages.set(fingerprint, { at: Date.now(), path: data.path });
    if (autoInsert && state.activeFile?.endsWith('.tex')) {
      insertSnippet(figureSnippet(data.path));
      notify(`已导入并插入 ${data.path}`, 'success');
    } else {
      notify(`已导入 ${data.path}`, 'success');
    }
  } catch (error) { notify(error.message, 'error'); }
}

const bibSkeletons = {
  article: key => `@article{${key},\n  title   = {论文标题},\n  author  = {作者姓名},\n  journal = {期刊名称},\n  year    = {2026},\n  volume  = {1},\n  number  = {1},\n  pages   = {1--10}\n}\n`,
  inproceedings: key => `@inproceedings{${key},\n  title     = {会议论文标题},\n  author    = {作者姓名},\n  booktitle = {会议名称 (Proceedings of ...)},\n  year      = {2026},\n  pages     = {1--8}\n}\n`,
  book: key => `@book{${key},\n  title     = {书名},\n  author    = {作者姓名},\n  publisher = {出版社},\n  year      = {2026}\n}\n`,
  phdthesis: key => `@phdthesis{${key},\n  title  = {学位论文题目},\n  author = {作者姓名},\n  school = {培养院校},\n  year   = {2026}\n}\n`,
  misc: key => `@misc{${key},\n  title        = {标题或预印本名称},\n  author       = {作者姓名},\n  year         = {2026},\n  howpublished = {\\url{https://arxiv.org/abs/...}}\n}\n`
};

async function addBibEntryTemplate(kind) {
  if (!state.projectRoot) { askProject(); return; }
  const makeSkeleton = bibSkeletons[kind] || bibSkeletons.article;
  let bibPath = state.activeFile?.endsWith('.bib')
    ? state.activeFile
    : (state.files.find(f => f.path === 'references.bib')?.path || state.files.find(f => f.path.endsWith('.bib'))?.path || null);
  try {
    if (!bibPath) {
      const created = await send('/api/file', 'POST', { path: 'references.bib', content: '% BibTeX 参考文献条目\n' });
      bibPath = created.path;
      state.files = (await request('/api/tree')).files;
      renderTree();
    }
    await openFile(bibPath);
    const placeholderKey = `ref${new Date().getFullYear()}_${state.references.length + 1}`;
    const entry = makeSkeleton(placeholderKey);
    const docLen = editor.state.doc.length;
    const prefix = docLen > 0 && !editor.state.doc.sliceString(Math.max(0, docLen - 1), docLen).endsWith('\n') ? '\n\n' : '\n';
    const insertText = prefix + entry;
    const keyOffset = insertText.indexOf(placeholderKey);
    editor.dispatch({
      changes: { from: docLen, to: docLen, insert: insertText },
      selection: { anchor: docLen + keyOffset, head: docLen + keyOffset + placeholderKey.length },
      effects: EditorView.scrollIntoView(docLen + keyOffset, { y: 'center' })
    });
    editor.focus();
    scheduleReferences(300);
    notify(`已在 ${bibPath} 末尾插入文献模板，修改后按 ⌘S 保存`, 'info');
  } catch (error) {
    notify(error.message, 'error');
  }
}

let referencesTimer = null;
// 上一次渲染引用面板时的数据指纹：内容没变就不必重建整个面板
let referencesRenderedSignature = '';

function scheduleReferences(delay = 700) {
  clearTimeout(referencesTimer);
  referencesTimer = setTimeout(() => loadReferences({ silent: true }), delay);
}

// 把所有还没保存的缓冲一起交给服务端（契约 §5：active 支持数组），
// 引用、全篇大纲、全篇字数才不会漏掉正在改的章节
function collectDirtyBuffers() {
  const buffers = [];
  const seen = new Set();
  const push = (path, content) => {
    if (!path || seen.has(path) || (!path.endsWith('.tex') && !path.endsWith('.bib'))) return;
    if (typeof content !== 'string') return;
    seen.add(path);
    buffers.push({ path, content });
  };
  if (state.activeFile) push(state.activeFile, editor.state.doc.toString());
  for (const [path, session] of fileSessions) {
    if (session?.editorState) push(path, session.editorState.doc.toString());
  }
  return buffers;
}

// One server-side pass keeps the citation panel, completions, project outline, and total word counts fresh;
// the buffers being edited are handed over so unsaved changes count too.
async function loadReferences({ silent = false } = {}) {
  if (!state.projectRoot) return;
  clearTimeout(referencesTimer);
  try {
    // 这个接口要扫全项目，前端超时留足余量，别被默认 15s 误杀
    const data = await send('/api/references', 'POST', { active: collectDirtyBuffers(), rootFile: state.rootFile }, { timeoutMs: 30_000 });
    state.references = data.bib || [];
    state.labels = data.labels || [];
    state.wordCounts = data.wordCounts || {};
    state.projectOutline = data.projectOutline || [];
    wordCountsEpoch++;
    const total = state.references.length + state.labels.length;
    $('#refTotalCount').textContent = total ? String(total) : '';
    let wordsTotal = 0;
    for (const entry of Object.values(state.wordCounts)) wordsTotal += entry?.total || 0;
    const signature = [
      state.references.map(item => item.key).join(','),
      state.labels.map(item => item.key).join(','),
      state.projectOutline.length,
      wordsTotal
    ].join('|');
    // 静默轮询（切标签 / 每次保存后）只在数据真的变了时重建面板，省下整段 DOM 重建
    if (!silent || signature !== referencesRenderedSignature) renderReferences();
    updateOutline();
    renderWordCount();
  } catch (error) { if (!silent) notify(error.message, 'error'); }
}

function renderReferences() {
  const query = state.refQuery.trim().toLowerCase();
  const filteredBib = state.references.filter(item => !query || [item.key, item.title, item.author, item.year, item.file].some(val => val?.toLowerCase().includes(query)));
  const filteredLabels = state.labels.filter(item => !query || [item.key, item.context, item.file].some(val => val?.toLowerCase().includes(query)));

  $('#bibCount').textContent = `${filteredBib.length}`;
  $('#labelCount').textContent = `${filteredLabels.length}`;

  const bibList = $('#bibList'); bibList.replaceChildren();
  if (!filteredBib.length) {
    const empty = document.createElement('p'); empty.className = 'reference-empty'; empty.textContent = query ? '没有匹配的文献条目。' : '尚未找到 .bib 条目，可点上方按钮新建。'; bibList.append(empty);
  } else {
    for (const item of filteredBib) {
      const card = document.createElement('div'); card.className = 'reference-card';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'reference-item';
      button.title = `点击插入 \\cite{${item.key}}`;
      const key = document.createElement('strong'); key.textContent = item.key;
      if (item.title) {
        const title = document.createElement('div'); title.className = 'reference-title'; title.textContent = item.title;
        button.append(key, title);
      } else {
        button.append(key);
      }
      const meta = document.createElement('span');
      meta.textContent = [item.author, item.year, item.type, `${item.file}${item.line ? `:${item.line}` : ''}`].filter(Boolean).join(' · ');
      const plus = document.createElement('span'); plus.className = 'reference-plus'; plus.textContent = '＋';
      button.append(meta, plus);
      button.addEventListener('click', () => insertSnippet(`\\cite{${item.key}}`));
      card.append(button);
      if (item.file) {
        const jumpBtn = document.createElement('button');
        jumpBtn.type = 'button';
        jumpBtn.className = 'reference-jump-btn';
        jumpBtn.title = `跳转到 ${item.file}${item.line ? ` 第 ${item.line} 行` : ''}`;
        jumpBtn.textContent = '↗';
        jumpBtn.addEventListener('click', () => openFile(item.file, item.line || 1));
        card.append(jumpBtn);
      }
      bibList.append(card);
    }
  }

  const labelList = $('#labelList'); labelList.replaceChildren();
  if (!filteredLabels.length) {
    const empty = document.createElement('p'); empty.className = 'reference-empty'; empty.textContent = query ? '没有匹配的 \\label 标签。' : '尚未找到 \\label。'; labelList.append(empty);
  } else {
    for (const item of filteredLabels) {
      const card = document.createElement('div'); card.className = 'reference-card';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'reference-item';
      const cmd = item.key.startsWith('eq:') ? 'eqref' : 'ref';
      button.title = `点击插入 \\${cmd}{${item.key}}`;
      const key = document.createElement('strong'); key.textContent = item.key;
      const meta = document.createElement('span');
      meta.textContent = [`\\${cmd}`, item.context, `${item.file}${item.line ? `:${item.line}` : ''}`].filter(Boolean).join(' · ');
      const plus = document.createElement('span'); plus.className = 'reference-plus'; plus.textContent = '＋';
      button.append(key, meta, plus);
      button.addEventListener('click', () => insertSnippet(`\\${cmd}{${item.key}}`));
      card.append(button);
      if (item.file) {
        const jumpBtn = document.createElement('button');
        jumpBtn.type = 'button';
        jumpBtn.className = 'reference-jump-btn';
        jumpBtn.title = `跳转到 ${item.file}${item.line ? ` 第 ${item.line} 行` : ''}`;
        jumpBtn.textContent = '↗';
        jumpBtn.addEventListener('click', () => openFile(item.file, item.line || 1));
        card.append(jumpBtn);
      }
      labelList.append(card);
    }
  }
  // 记住这次渲染对应的数据指纹，供 loadReferences 的静默轮询判断要不要再来一遍
  let wordsTotal = 0;
  for (const entry of Object.values(state.wordCounts)) wordsTotal += entry?.total || 0;
  referencesRenderedSignature = [
    state.references.map(item => item.key).join(','),
    state.labels.map(item => item.key).join(','),
    state.projectOutline.length,
    wordsTotal
  ].join('|');
}

let searchTimer = null;
let searchMatches = [];
let searchActive = -1;
function openSearch() {
  if (!state.projectRoot) { askProject(); return; }
  if ($('#quickOpenModal').open) $('#quickOpenModal').close();
  const modal = $('#searchModal');
  modal.showModal();
  const input = $('#searchInput');
  input.focus();
  input.select();
  if (state.searchQuery) runSearch(); else { renderSearchResults(); $('#searchMeta').textContent = '输入关键词开始搜索，回车或点击结果可跳转到对应行。'; }
}

function closeSearch() {
  $('#searchModal').close();
  editor.focus();
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function searchSnippet(item) {
  const text = item.text;
  if (!item.length || item.start == null || item.start < 0) return escapeHtml(text.slice(0, 200));
  const start = Math.max(0, item.start - 28);
  const pre = (start > 0 ? '…' : '') + text.slice(start, item.start);
  const hit = text.slice(item.start, item.start + item.length);
  const post = text.slice(item.start + item.length, item.start + item.length + 140);
  return `${escapeHtml(pre)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(post)}${post.length >= 140 ? '…' : ''}`;
}

async function runSearch() {
  const query = $('#searchInput').value;
  state.searchQuery = query;
  clearTimeout(searchTimer);
  if (!query) { searchMatches = []; searchActive = -1; renderSearchResults(); $('#searchMeta').textContent = '输入关键词开始搜索，回车或点击结果可跳转到对应行。'; $('#searchTruncated').textContent = ''; return; }
  $('#searchMeta').textContent = '正在搜索…';
  searchTimer = setTimeout(async () => {
    try {
      const data = await send('/api/search', 'POST', {
        query,
        caseSensitive: state.searchCaseSensitive,
        regex: state.searchRegex,
        active: collectDirtyBuffers()
      }, { timeoutMs: 30_000 });
      // Ignore stale responses if the query changed while waiting
      if ($('#searchInput').value !== query) return;
      searchMatches = data.matches;
      searchActive = searchMatches.length ? 0 : -1;
      const fileCount = new Set(searchMatches.map(item => item.file)).size;
      // 「没扫完」不等于「没有」：超时或只扫了前 N 个文件时说成「没有找到匹配内容」，
      // 用户会以为那个词真的不存在——把没扫完谎报成没有，比慢更糟。三档文案分开写。
      if (searchMatches.length) {
        $('#searchMeta').textContent = `${searchMatches.length} 处匹配 · 分布在 ${fileCount} 个文件`;
        $('#searchTruncated').textContent = data.truncated ? '（结果过多，已截断，请缩小搜索范围）' : '';
      } else if (data.timedOut) {
        $('#searchMeta').textContent = '搜索超时，没有扫完，还不清楚有没有匹配。';
        $('#searchTruncated').textContent = '（换个更长或更独特的关键词再试）';
      } else if (data.truncated) {
        $('#searchMeta').textContent = data.filesSearched
          ? `只扫完前 ${data.filesSearched} 个文件，其中没有匹配。`
          : '项目太大，没有扫完，其中没有匹配。';
        $('#searchTruncated').textContent = '（换个更长或更独特的关键词再试）';
      } else {
        $('#searchMeta').textContent = '没有找到匹配内容。';
        $('#searchTruncated').textContent = '';
      }
      renderSearchResults();
    } catch (error) {
      $('#searchMeta').textContent = error.message;
      searchMatches = []; searchActive = -1;
      renderSearchResults();
    }
  }, 180);
}

function renderSearchResults() {
  const box = $('#searchResults');
  box.replaceChildren();
  if (!searchMatches.length) return;
  let currentFile = null;
  searchMatches.forEach((item, index) => {
    if (item.file !== currentFile) {
      currentFile = item.file;
      const header = document.createElement('div');
      header.className = 'search-file-header';
      header.textContent = currentFile;
      box.append(header);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-item' + (index === searchActive ? ' active' : '');
    button.dataset.index = String(index);
    const lineNumber = document.createElement('span');
    lineNumber.className = 'search-line';
    lineNumber.textContent = String(item.line);
    const snippet = document.createElement('span');
    snippet.className = 'search-snippet';
    snippet.innerHTML = searchSnippet(item);
    button.append(lineNumber, snippet);
    button.addEventListener('click', () => chooseSearchMatch(index));
    box.append(button);
  });
}

function moveSearchActive(delta) {
  if (!searchMatches.length) return;
  searchActive = (searchActive + delta + searchMatches.length) % searchMatches.length;
  renderSearchResults();
  const active = $('#searchResults').querySelector('.search-item.active');
  active?.scrollIntoView({ block: 'nearest' });
}

async function chooseSearchMatch(index) {
  const item = searchMatches[index];
  if (!item) return;
  closeSearch();
  if (item.file === state.activeFile) {
    jumpToLine(item.line);
  } else {
    await openFile(item.file, item.line);
  }
}

// Quick Switcher (⌘P): jump to any file or section heading across the entire project
let quickOpenItems = [];
let quickOpenActive = 0;

function buildQuickOpenItems(query) {
  const q = query.trim().toLowerCase();
  const items = [];
  for (const file of state.files) {
    const label = file.path.split('/').pop();
    if (!q || file.path.toLowerCase().includes(q)) {
      items.push({
        kind: file.type === 'image' ? 'image' : 'file',
        title: label,
        subtitle: file.path + (file.path === state.rootFile ? ' · 主文件' : ''),
        file: file.path,
        line: null,
        score: file.path === state.activeFile ? 1 : (label.toLowerCase().startsWith(q) ? 0 : 2)
      });
    }
  }
  const headings = getEffectiveOutline();
  for (const h of headings) {
    const hay = `${h.title} ${h.file || ''}`.toLowerCase();
    if (!q || hay.includes(q)) {
      items.push({
        kind: 'heading',
        title: `§ ${h.title}`,
        subtitle: `${h.file || state.activeFile} : 第 ${h.line} 行`,
        file: h.file || state.activeFile,
        line: h.line,
        score: q ? (h.title.toLowerCase().startsWith(q) ? 1 : 3) : 4
      });
    }
  }
  return items.sort((a, b) => a.score - b.score).slice(0, 60);
}

function openQuickSwitcher() {
  if (!state.projectRoot) { askProject(); return; }
  if ($('#searchModal').open) $('#searchModal').close();
  const modal = $('#quickOpenModal');
  const input = $('#quickOpenInput');
  input.value = '';
  quickOpenItems = buildQuickOpenItems('');
  quickOpenActive = 0;
  renderQuickOpenResults();
  modal.showModal();
  input.focus();
}

function closeQuickSwitcher() {
  $('#quickOpenModal').close();
  editor.focus();
}

function renderQuickOpenResults() {
  const box = $('#quickOpenResults');
  box.replaceChildren();
  if (!quickOpenItems.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = '没有匹配的文件或章节标题。';
    box.append(empty);
    return;
  }
  quickOpenItems.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-item quick-open-item' + (index === quickOpenActive ? ' active' : '');
    const badge = document.createElement('span');
    badge.className = 'quick-kind-badge ' + item.kind;
    badge.textContent = item.kind === 'heading' ? '节' : item.kind === 'image' ? '图' : '文';
    const main = document.createElement('span');
    main.className = 'quick-open-title';
    main.textContent = item.title;
    const sub = document.createElement('span');
    sub.className = 'quick-open-sub';
    sub.textContent = item.subtitle;
    btn.append(badge, main, sub);
    btn.addEventListener('click', () => chooseQuickOpenItem(index));
    box.append(btn);
  });
}

async function chooseQuickOpenItem(index) {
  const item = quickOpenItems[index];
  if (!item) return;
  closeQuickSwitcher();
  if (item.kind === 'image') {
    showTab('insert');
    $('#imageSelect').value = item.file;
    updateImageThumb();
    notify(`已选中图片 ${item.file}`);
    return;
  }
  await openFile(item.file, item.line);
}

async function createFile() {
  if (!state.projectRoot) return;
  showModal({ title: '新建文件', description: '请输入相对于项目目录的文件名（如 sections/intro.tex），子文件夹会自动创建。', placeholder: 'sections/introduction.tex', submit: '创建文件', action: async value => {
    try {
      const data = await send('/api/file', 'POST', { path: value.trim(), content: '' });
      state.files = (await request('/api/tree')).files;
      if (!state.rootFile && data.path.endsWith('.tex')) state.rootFile = data.path;
      renderTree(); renderRootPicker(); await openFile(data.path);
      notify('文件已创建', 'success');
    } catch (error) { notify(error.message, 'error'); }
  } });
}

async function createTemplate(kind) {
  if (!state.projectRoot) { askProject(); return; }
  try {
    const result = await send('/api/template', 'POST', { kind });
    state.files = result.files; state.rootFile = result.main;
    renderAll(); await openFile(result.main);
    scheduleReferences(100);
    notify('模板已创建，可以开始写作', 'success');
  } catch (error) { notify(error.message, 'error'); }
}

function setRootFile(newRoot) {
  if (state.compiling) {
    // 编译进行中换主文件会让 A 的 PDF / SyncTeX 被当成新主文件 B 的结果来渲染与反查
    notify('编译正在进行，先取消或等它结束再切换主文件', 'error');
    renderRootPicker();
    return;
  }
  state.rootFile = newRoot || null;
  if (state.projectRoot && state.rootFile) {
    try { localStorage.setItem(`yantai:rootFile:${state.projectRoot}`, state.rootFile); } catch {}
  }
  state.pdfUrl = null;
  state.pdfFingerprint = null;
  state.pdfStale = false;
  state.result = null;
  state.fullCompileBackup = null;
  populateFileDiagnostics([]);
  renderRootPicker();
  renderTree();
  renderFileStatus();
  renderResult();
  scheduleReferences(100);
  $('#compileButton').disabled = !state.rootFile;
}

$('#modal').addEventListener('close', () => { if ($('#modal').returnValue === 'submit' && modalAction) modalAction($('#modalInput').value); });
$('#chooseFolder').addEventListener('click', () => { $('#modal').close('cancel'); openProject(null, true); });
$('#toggleSidebar').addEventListener('click', toggleSidebar);
$('#openProjectTop').addEventListener('click', askProject);
$('#headerProjectTrigger').addEventListener('click', askProject);
$('#emptyOpen').addEventListener('click', askProject);
$('#topbarMore').addEventListener('click', event => { event.stopPropagation(); toggleHeaderMenu(); });
// 菜单里点按钮就收起（复选框是连续操作，点完保持展开）
$('#topbarOverflow').addEventListener('click', event => { if (event.target.closest('button')) toggleHeaderMenu(false); });
document.addEventListener('pointerdown', event => {
  const actions = $('.header-actions');
  if (!actions?.classList.contains('menu-open') || event.target.closest('.header-actions')) return;
  toggleHeaderMenu(false);
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') toggleHeaderMenu(false); });
$('#saveButton').addEventListener('click', async () => {
  const ok = await saveFile();
  if (ok && state.autoCompile && !state.compiling) compile({ silentSuccess: true });
});
$('#reloadConflictFile').addEventListener('click', reloadActiveFileFromDisk);
$('#keepEditingConflict').addEventListener('click', () => { $('#conflictBar').hidden = true; notify('保留当前编辑内容，保存时将写入当前内容'); editor.focus(); });
$('#forceSaveConflictFile').addEventListener('click', async () => {
  const ok = await saveFile({ force: true });
  if (ok && state.autoCompile && !state.compiling) compile({ silentSuccess: true });
});
$('#compileButton').addEventListener('click', () => compile());
$('#cancelCompileButton').addEventListener('click', cancelCurrentCompile);
$('#syncToPdfBtn').addEventListener('click', () => syncCursorToPdf());
$('#snippetCompileBtn').addEventListener('click', () => compileSelectedText());
$('#snippetBackToLine').addEventListener('click', () => {
  const meta = state.result?.snippetMeta;
  if (meta?.editorFile) openFile(meta.editorFile, meta.fromLine || 1);
});
$('#exitSnippetPreview').addEventListener('click', exitSnippetPreview);
$('#fontSmaller').addEventListener('click', () => {
  state.editorFontSize = Math.max(12, state.editorFontSize - 1);
  try { localStorage.setItem('yantai:fontSize', String(state.editorFontSize)); } catch {}
  applyEditorFontSize();
});
$('#fontLarger').addEventListener('click', () => {
  state.editorFontSize = Math.min(20, state.editorFontSize + 1);
  try { localStorage.setItem('yantai:fontSize', String(state.editorFontSize)); } catch {}
  applyEditorFontSize();
});
$('#cursorPos').addEventListener('click', () => {
  if (!state.activeFile) return;
  editor.focus();
  gotoLine(editor);
});
$('#revealPdf').addEventListener('click', revealPdfInFinder);
$('#cleanBuildTop').addEventListener('click', cleanBuildArtifacts);
$('#cleanBuildLogs').addEventListener('click', cleanBuildArtifacts);
$('#copyRawLog').addEventListener('click', async () => {
  const text = $('#rawLog').textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    notify('编译日志已复制到剪贴板', 'success');
  } catch {
    notify('复制失败，请手动选中复制', 'error');
  }
});
document.querySelectorAll('[data-log-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.logFilter = btn.dataset.logFilter || 'all';
    renderDiagnosticsList();
  });
});
$('#refreshTree').addEventListener('click', refreshTree);
$('#revealFinder').addEventListener('click', revealInFinder);
$('#newFile').addEventListener('click', createFile);
$('#treeFilterInput').addEventListener('input', event => {
  state.treeFilter = event.target.value;
  renderTree();
});
$('#quickOpenBtn').addEventListener('click', openQuickSwitcher);
$('#quickOpenClose').addEventListener('click', closeQuickSwitcher);
$('#quickOpenModal').addEventListener('click', event => { if (event.target === $('#quickOpenModal')) closeQuickSwitcher(); });
$('#quickOpenModal').addEventListener('cancel', event => { event.preventDefault(); closeQuickSwitcher(); });
$('#quickOpenInput').addEventListener('input', event => {
  quickOpenItems = buildQuickOpenItems(event.target.value);
  quickOpenActive = 0;
  renderQuickOpenResults();
});
$('#quickOpenInput').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (quickOpenItems.length) {
      quickOpenActive = (quickOpenActive + 1) % quickOpenItems.length;
      renderQuickOpenResults();
      $('#quickOpenResults').querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (quickOpenItems.length) {
      quickOpenActive = (quickOpenActive - 1 + quickOpenItems.length) % quickOpenItems.length;
      renderQuickOpenResults();
      $('#quickOpenResults').querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (quickOpenItems.length) chooseQuickOpenItem(quickOpenActive);
  }
});
$('#searchProjectBtn').addEventListener('click', openSearch);
$('#searchClose').addEventListener('click', closeSearch);
$('#searchInput').addEventListener('input', runSearch);
$('#searchInput').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); moveSearchActive(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); moveSearchActive(-1); }
  else if (event.key === 'Enter') {
    event.preventDefault();
    if (searchActive >= 0) chooseSearchMatch(searchActive);
    else if (searchMatches.length) chooseSearchMatch(0);
  }
});
$('#searchModal').addEventListener('click', event => { if (event.target === $('#searchModal')) closeSearch(); });
$('#searchModal').addEventListener('cancel', event => { event.preventDefault(); closeSearch(); });
const toggleSearchFlag = (id, key) => $(id).addEventListener('click', () => {
  state[key] = !state[key];
  $(id).classList.toggle('active', state[key]);
  runSearch();
});
toggleSearchFlag('#searchCase', 'searchCaseSensitive');
toggleSearchFlag('#searchRegex', 'searchRegex');

// Global shortcuts so ⌘S never triggers browser "Save Page As" and ⌘↵ / ⌘P / ⌘J / ⌘\ work from any panel
window.addEventListener('keydown', event => {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return;
  if (event.shiftKey && event.code === 'KeyF') {
    event.preventDefault();
    if ($('#searchModal').open) closeSearch(); else openSearch();
    return;
  }
  if (!event.shiftKey && !event.altKey && event.code === 'KeyP') {
    event.preventDefault();
    if ($('#quickOpenModal').open) closeQuickSwitcher(); else openQuickSwitcher();
    return;
  }
  if (!event.shiftKey && !event.altKey && event.code === 'KeyS') {
    event.preventDefault();
    saveFile().then(ok => {
      if (ok && state.autoCompile && !state.compiling) compile({ silentSuccess: true });
    });
    return;
  }
  if ($('#modal').open || $('#searchModal').open || $('#quickOpenModal').open) return;
  if (!event.shiftKey && event.key === 'Enter') {
    if (event.target === $('#equationInput')) {
      event.preventDefault();
      insertEquation();
      return;
    }
    if (!isTypingContext(event.target)) {
      event.preventDefault();
      compile();
      return;
    }
  }
  if (!event.shiftKey && !event.altKey && event.code === 'Backslash') {
    event.preventDefault();
    toggleSidebar();
  } else if (!event.shiftKey && !event.altKey && event.code === 'KeyJ' && !isTypingContext(event.target)) {
    event.preventDefault();
    syncCursorToPdf();
  } else if (event.shiftKey && event.code === 'KeyE' && !isTypingContext(event.target)) {
    event.preventDefault();
    goToNextDiagnostic();
  }
});

$('#autoSaveToggle').addEventListener('change', event => {
  state.autoSave = event.target.checked;
  try { localStorage.setItem('yantai:autoSave', state.autoSave ? '1' : '0'); } catch {}
  renderFileStatus();
  if (state.autoSave && state.dirty) saveFile({ silent: true });
  notify(state.autoSave ? '已开启自动保存' : '已关闭自动保存');
});
$('#autoCompileToggle').addEventListener('change', event => {
  state.autoCompile = event.target.checked;
  try { localStorage.setItem('yantai:autoCompile', state.autoCompile ? '1' : '0'); } catch {}
  notify(state.autoCompile ? '已开启保存即编译' : '已关闭保存即编译');
});
document.querySelectorAll('[data-side]').forEach(btn => btn.addEventListener('click', () => setSidebarMode(btn.dataset.side)));
document.querySelectorAll('[data-outline-scope]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.outlineMode = btn.dataset.outlineScope === 'file' ? 'file' : 'project';
    try { localStorage.setItem('yantai:outlineMode', state.outlineMode); } catch {}
    updateOutline();
  });
});
$('#fileTree').addEventListener('click', event => {
  const folderBtn = event.target.closest('[data-folder]');
  if (folderBtn) {
    const folder = folderBtn.dataset.folder;
    if (state.collapsedFolders.has(folder)) state.collapsedFolders.delete(folder);
    else state.collapsedFolders.add(folder);
    renderTree();
    return;
  }
  const setRootBtn = event.target.closest('[data-set-root]');
  if (setRootBtn) {
    event.stopPropagation();
    const target = setRootBtn.dataset.setRoot;
    setRootFile(target);
    notify(`已将 ${target} 设为主编译文件`, 'success');
    return;
  }
  const button = event.target.closest('[data-path]');
  if (!button) return;
  const item = state.files.find(file => file.path === button.dataset.path);
  if (!item) return;
  if (item.type === 'text') {
    openFile(item.path);
  } else if (item.type === 'image') {
    showTab('insert');
    $('#imageSelect').value = item.path;
    updateImageThumb();
    notify(`已选中图片 ${item.path}`);
  }
});
$('#rootFile').addEventListener('change', event => {
  setRootFile(event.target.value || null);
});
document.querySelectorAll('[data-template]').forEach(button => button.addEventListener('click', () => createTemplate(button.dataset.template)));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => showTab(button.dataset.tab)));
document.querySelectorAll('[data-snippet]').forEach(button => button.addEventListener('click', () => quickSnippet(button.dataset.snippet)));
$('#mathCatTabs').addEventListener('click', event => {
  const btn = event.target.closest('[data-math-cat]');
  if (!btn) return;
  state.mathCat = btn.dataset.mathCat;
  renderMathPalette();
});
$('#mathPalette').addEventListener('click', event => {
  const btn = event.target.closest('[data-tex]');
  if (!btn) return;
  const input = $('#equationInput');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const tex = btn.dataset.tex;
  input.value = input.value.slice(0, start) + tex + input.value.slice(end);
  input.focus();
  const brace = tex.indexOf('{');
  const cursor = start + (brace >= 0 ? brace + 1 : tex.length);
  input.setSelectionRange(cursor, cursor);
});
$('#insertEquation').addEventListener('click', insertEquation);
$('#insertMathDirect').addEventListener('click', insertMathContentDirect);
$('#pasteTableBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    applyParsedTable(parseDelimitedTable(text));
  } catch {
    notify('请在下方任意单元格内直接按 ⌘V 粘贴表格内容', 'info');
  }
});
$('#clearTableBtn').addEventListener('click', () => {
  tableData = [];
  drawTableGrid();
  notify('表格数据已清空');
});
$('#insertTable').addEventListener('click', insertTable);
$('#insertImage').addEventListener('click', insertImage);
$('#imageSelect').addEventListener('change', updateImageThumb);
$('#imageUpload').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) uploadImage(file); event.target.value = ''; });
$('#tableRows').addEventListener('change', drawTableGrid);
$('#tableCols').addEventListener('change', drawTableGrid);
document.querySelectorAll('[data-bib-kind]').forEach(btn => {
  btn.addEventListener('click', () => addBibEntryTemplate(btn.dataset.bibKind));
});
$('#refreshReferences').addEventListener('click', () => loadReferences());
$('#referenceSearch').addEventListener('input', event => {
  state.refQuery = event.target.value;
  renderReferences();
});
$('#previousPage').addEventListener('click', () => goToPdfPage(pdfPage - 1));
$('#nextPage').addEventListener('click', () => goToPdfPage(pdfPage + 1));
$('#pageInput').addEventListener('change', event => goToPdfPage(Number(event.target.value)));
$('#pageInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    goToPdfPage(Number(event.target.value));
  }
});
$('#zoomOut').addEventListener('click', () => {
  pdfZoom = Math.max(0.5, Number((pdfZoom - 0.15).toFixed(2)));
  renderPdfView(pdfGeneration, { preserveScroll: true });
});
$('#zoomReset').addEventListener('click', () => {
  if (pdfZoom !== 1) {
    pdfZoom = 1;
  } else {
    state.pdfFitMode = state.pdfFitMode === 'width' ? 'page' : 'width';
    try { localStorage.setItem('yantai:pdfFit', state.pdfFitMode); } catch {}
  }
  renderPdfView(pdfGeneration, { preserveScroll: true });
});
$('#zoomIn').addEventListener('click', () => {
  pdfZoom = Math.min(2.5, Number((pdfZoom + 0.15).toFixed(2)));
  renderPdfView(pdfGeneration, { preserveScroll: true });
});
$('#togglePdfMode').addEventListener('click', () => {
  state.pdfScrollMode = state.pdfScrollMode === 'continuous' ? 'single' : 'continuous';
  try { localStorage.setItem('yantai:pdfMode', state.pdfScrollMode); } catch {}
  renderPdfView(pdfGeneration, { preserveScroll: false });
});

// 连续模式页高等距，用步长反推当前页：几百页时不再每个滚动事件遍历所有 wrap
$('#pdfStage').addEventListener('scroll', () => {
  if (!pdfDocument || state.pdfScrollMode !== 'continuous' || !pdfPageStride) return;
  if (Date.now() < pdfProgrammaticScrollUntil) return;
  const stage = $('#pdfStage');
  // 用视口中线反推页码：goToPdfPage 停在页头顶边 16px 处，按页顶算会把第 2 页读成第 1 页
  const page = Math.min(pdfDocument.numPages, Math.max(1, Math.floor((stage.scrollTop + stage.clientHeight / 2 - pdfFirstPageTop) / pdfPageStride) + 1));
  if (page !== pdfPage) {
    pdfPage = page;
    updatePdfToolbarControls();
  }
}, { passive: true });

// 用户一开始滚就放弃程序滚动：pointerdown/wheel 会让 Chrome 取消 smooth 动画，
// 宽限期再继续吃住页码，就变成「手在动、页码不动」
$('#pdfStage').addEventListener('wheel', () => { pdfProgrammaticScrollUntil = 0; }, { passive: true });
$('#pdfStage').addEventListener('pointerdown', () => { pdfProgrammaticScrollUntil = 0; }, { passive: true });
$('#pdfStage').addEventListener('touchstart', () => { pdfProgrammaticScrollUntil = 0; }, { passive: true });

// Trackpad pinch-to-zoom (Ctrl/Cmd + wheel) inside PDF preview.
// passive: true —— 不在滚轮事件里阻塞默认行为（页面横向滚动由 CSS overscroll/touch-action 兜住）
let wheelZoomTimer = null;
$('#pdfStage').addEventListener('wheel', event => {
  if (!pdfDocument || !(event.ctrlKey || event.metaKey)) return;
  const delta = event.deltaY < 0 ? 0.08 : -0.08;
  pdfZoom = Math.max(0.5, Math.min(2.5, Number((pdfZoom + delta).toFixed(2))));
  updatePdfToolbarControls();
  clearTimeout(wheelZoomTimer);
  wheelZoomTimer = setTimeout(() => {
    renderPdfView(pdfGeneration, { preserveScroll: true });
  }, 60);
}, { passive: true });

const resizer = $('#panelResizer');
const INSPECTOR_WIDTH_KEY = 'yantai:inspectorWidth';

function applyInspectorWidth(percent) {
  const value = Math.min(72, Math.max(22, Number(percent) || 46));
  $('#workspace').style.setProperty('--inspector-width', `${value}%`);
  return value;
}

try {
  const savedWidth = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
  if (savedWidth >= 22 && savedWidth <= 72) applyInspectorWidth(savedWidth);
} catch {}

resizer.addEventListener('pointerdown', event => {
  if (window.innerWidth <= 900) return;
  // pointerdown 上就吃掉默认行为，拖动过程不会顺手选中海报里的文字；只作用于分隔条本身
  event.preventDefault();
  // 捕获失败（例如指针已经抬起）也不能让整个处理器中断，否则拖动样式会卡在页面上
  // 指针可能已经抬起（触屏快速松手），这时 setPointerCapture 会抛 NotFoundError；
  // 捕获不到也要继续拖：move/up 挂在 window 上，一样能跟住指针
  try { resizer.setPointerCapture(event.pointerId); } catch {}
  resizer.classList.add('dragging');
  document.body.classList.add('resizing-panels');
  const workspace = $('#workspace');
  let latestPercent = null;
  const onMove = moveEvent => {
    const rect = workspace.getBoundingClientRect();
    const minLeft = state.sidebarCollapsed ? 310 : 540;
    const rightWidth = Math.max(300, Math.min(rect.width - minLeft, rect.right - moveEvent.clientX));
    latestPercent = applyInspectorWidth((rightWidth / rect.width) * 100);
  };
  const onUp = () => {
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing-panels');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    // 记住这次拖到的宽度，重开浏览器还是这个比例
    if (latestPercent != null) {
      try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(latestPercent)); } catch {}
    }
    if (pdfDocument) {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => renderPdfView(pdfGeneration, { preserveScroll: true }));
    }
  };
  // 挂在 window 上：指针捕获失败或鼠标划出分隔条时拖动依然连续
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
});
// 双击分隔条恢复默认分栏
resizer.addEventListener('dblclick', () => {
  applyInspectorWidth(46);
  try { localStorage.removeItem(INSPECTOR_WIDTH_KEY); } catch {}
  if (pdfDocument) {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => renderPdfView(pdfGeneration, { preserveScroll: true }));
  }
});

window.addEventListener('resize', () => {
  if (!pdfDocument) return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => renderPdfView(pdfGeneration, { preserveScroll: true }));
});

// Re-check the disk file when returning to this tab (e.g. after editing in VS Code / Finder)
window.addEventListener('focus', () => { checkExternalChange(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkExternalChange(); });

// 任何冒泡到 window 的异常都不该静默：至少提示一句
window.addEventListener('error', windowErrorHandlers.error);
window.addEventListener('unhandledrejection', windowErrorHandlers.rejection);

window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });

drawTableGrid(); renderMathPalette(); renderAll();
request('/api/status').then(data => {
  const previous = (() => { try { return localStorage.getItem('yantai:lastProject'); } catch { return null; } })();
  if (data.projectRoot || previous) openProject(data.projectRoot || previous);
}).catch(() => notify('无法连接本地服务，请运行 ./start.sh 或 npm start', 'error'));
