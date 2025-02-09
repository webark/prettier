import escapeStringRegexp from "escape-string-regexp";
import {
  skip,
  skipWhitespace,
  skipSpaces,
  skipToLineEnd,
  skipEverythingButNewLine,
} from "../utils/text/skip.js";
import skipInlineComment from "../utils/text/skip-inline-comment.js";
import skipTrailingComment from "../utils/text/skip-trailing-comment.js";
import skipNewline from "../utils/text/skip-newline.js";
import getNextNonSpaceNonCommentCharacterIndexWithStartIndex from "../utils/text/get-next-non-space-non-comment-character-index-with-start-index.js";

/**
 * @typedef {{backwards?: boolean}} SkipOptions
 */

/**
 * @param {string} text
 * @param {number} index
 * @param {SkipOptions=} opts
 * @returns {boolean}
 */
function hasNewline(text, index, opts = {}) {
  const idx = skipSpaces(text, opts.backwards ? index - 1 : index, opts);
  const idx2 = skipNewline(text, idx, opts);
  return idx !== idx2;
}

/**
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function hasNewlineInRange(text, start, end) {
  for (let i = start; i < end; ++i) {
    if (text.charAt(i) === "\n") {
      return true;
    }
  }
  return false;
}

// Note: this function doesn't ignore leading comments unlike isNextLineEmpty
/**
 * @template N
 * @param {string} text
 * @param {N} node
 * @param {(node: N) => number} locStart
 */
function isPreviousLineEmpty(text, node, locStart) {
  /** @type {number | false} */
  let idx = locStart(node) - 1;
  idx = skipSpaces(text, idx, { backwards: true });
  idx = skipNewline(text, idx, { backwards: true });
  idx = skipSpaces(text, idx, { backwards: true });
  const idx2 = skipNewline(text, idx, { backwards: true });
  return idx !== idx2;
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function isNextLineEmptyAfterIndex(text, index) {
  /** @type {number | false} */
  let oldIdx = null;
  /** @type {number | false} */
  let idx = index;
  while (idx !== oldIdx) {
    // We need to skip all the potential trailing inline comments
    oldIdx = idx;
    idx = skipToLineEnd(text, idx);
    idx = skipInlineComment(text, idx);
    idx = skipSpaces(text, idx);
  }
  idx = skipTrailingComment(text, idx);
  idx = skipNewline(text, idx);
  return idx !== false && hasNewline(text, idx);
}

/**
 * @template N
 * @param {string} text
 * @param {N} node
 * @param {(node: N) => number} locEnd
 * @returns {boolean}
 */
function isNextLineEmpty(text, node, locEnd) {
  return isNextLineEmptyAfterIndex(text, locEnd(node));
}

/**
 * @template N
 * @param {string} text
 * @param {N} node
 * @param {(node: N) => number} locEnd
 * @returns {number | false}
 */
function getNextNonSpaceNonCommentCharacterIndex(text, node, locEnd) {
  return getNextNonSpaceNonCommentCharacterIndexWithStartIndex(
    text,
    locEnd(node)
  );
}

/**
 * @template N
 * @param {string} text
 * @param {N} node
 * @param {(node: N) => number} locEnd
 * @returns {string}
 */
function getNextNonSpaceNonCommentCharacter(text, node, locEnd) {
  return text.charAt(
    // @ts-expect-error => TBD: can return false, should we define a fallback?
    getNextNonSpaceNonCommentCharacterIndex(text, node, locEnd)
  );
}

// Not using, but it's public utils
/* c8 ignore start */
/**
 * @param {string} text
 * @param {number} index
 * @param {SkipOptions=} opts
 * @returns {boolean}
 */
function hasSpaces(text, index, opts = {}) {
  const idx = skipSpaces(text, opts.backwards ? index - 1 : index, opts);
  return idx !== index;
}
/* c8 ignore stop */

/**
 * @param {string} value
 * @param {number} tabWidth
 * @param {number=} startIndex
 * @returns {number}
 */
function getAlignmentSize(value, tabWidth, startIndex = 0) {
  let size = 0;
  for (let i = startIndex; i < value.length; ++i) {
    if (value[i] === "\t") {
      // Tabs behave in a way that they are aligned to the nearest
      // multiple of tabWidth:
      // 0 -> 4, 1 -> 4, 2 -> 4, 3 -> 4
      // 4 -> 8, 5 -> 8, 6 -> 8, 7 -> 8 ...
      size = size + tabWidth - (size % tabWidth);
    } else {
      size++;
    }
  }

  return size;
}

/**
 * @param {string} value
 * @param {number} tabWidth
 * @returns {number}
 */
function getIndentSize(value, tabWidth) {
  const lastNewlineIndex = value.lastIndexOf("\n");
  /* c8 ignore next 3 */
  if (lastNewlineIndex === -1) {
    return 0;
  }

  return getAlignmentSize(
    // All the leading whitespaces
    value.slice(lastNewlineIndex + 1).match(/^[\t ]*/)[0],
    tabWidth
  );
}

/**
 * @typedef {'"' | "'"} Quote
 */

/**
 *
 * @param {string} rawContent
 * @param {Quote} preferredQuote
 * @returns {{ quote: Quote, regex: RegExp, escaped: string }}
 */

function getPreferredQuote(rawContent, preferredQuote) {
  /** @type {{ quote: '"', regex: RegExp, escaped: "&quot;" }} */
  const double = { quote: '"', regex: /"/g, escaped: "&quot;" };
  /** @type {{ quote: "'", regex: RegExp, escaped: "&apos;" }} */
  const single = { quote: "'", regex: /'/g, escaped: "&apos;" };

  const preferred = preferredQuote === "'" ? single : double;
  const alternate = preferred === single ? double : single;

  let result = preferred;

  // If `rawContent` contains at least one of the quote preferred for enclosing
  // the string, we might want to enclose with the alternate quote instead, to
  // minimize the number of escaped quotes.
  if (
    rawContent.includes(preferred.quote) ||
    rawContent.includes(alternate.quote)
  ) {
    const numPreferredQuotes = (rawContent.match(preferred.regex) || []).length;
    const numAlternateQuotes = (rawContent.match(alternate.regex) || []).length;

    result = numPreferredQuotes > numAlternateQuotes ? alternate : preferred;
  }

  return result;
}

function printString(raw, options) {
  // `rawContent` is the string exactly like it appeared in the input source
  // code, without its enclosing quotes.
  const rawContent = raw.slice(1, -1);

  /** @type {Quote} */
  const enclosingQuote =
    options.parser === "json" ||
    (options.parser === "json5" &&
      options.quoteProps === "preserve" &&
      !options.singleQuote)
      ? '"'
      : options.__isInHtmlAttribute
      ? "'"
      : getPreferredQuote(rawContent, options.singleQuote ? "'" : '"').quote;

  // It might sound unnecessary to use `makeString` even if the string already
  // is enclosed with `enclosingQuote`, but it isn't. The string could contain
  // unnecessary escapes (such as in `"\'"`). Always using `makeString` makes
  // sure that we consistently output the minimum amount of escaped quotes.
  return makeString(
    rawContent,
    enclosingQuote,
    !(
      options.parser === "css" ||
      options.parser === "less" ||
      options.parser === "scss" ||
      options.__embeddedInHtml
    )
  );
}

/**
 * @param {string} rawContent
 * @param {Quote} enclosingQuote
 * @param {boolean=} unescapeUnnecessaryEscapes
 * @returns {string}
 */
function makeString(rawContent, enclosingQuote, unescapeUnnecessaryEscapes) {
  const otherQuote = enclosingQuote === '"' ? "'" : '"';

  // Matches _any_ escape and unescaped quotes (both single and double).
  const regex = /\\(.)|(["'])/gs;

  // Escape and unescape single and double quotes as needed to be able to
  // enclose `rawContent` with `enclosingQuote`.
  const newContent = rawContent.replace(regex, (match, escaped, quote) => {
    // If we matched an escape, and the escaped character is a quote of the
    // other type than we intend to enclose the string with, there's no need for
    // it to be escaped, so return it _without_ the backslash.
    if (escaped === otherQuote) {
      return escaped;
    }

    // If we matched an unescaped quote and it is of the _same_ type as we
    // intend to enclose the string with, it must be escaped, so return it with
    // a backslash.
    if (quote === enclosingQuote) {
      return "\\" + quote;
    }

    if (quote) {
      return quote;
    }

    // Unescape any unnecessarily escaped character.
    // Adapted from https://github.com/eslint/eslint/blob/de0b4ad7bd820ade41b1f606008bea68683dc11a/lib/rules/no-useless-escape.js#L27
    return unescapeUnnecessaryEscapes &&
      /^[^\n\r"'0-7\\bfnrt-vx\u2028\u2029]$/.test(escaped)
      ? escaped
      : "\\" + escaped;
  });

  return enclosingQuote + newContent + enclosingQuote;
}

function printNumber(rawNumber) {
  return (
    rawNumber
      .toLowerCase()
      // Remove unnecessary plus and zeroes from scientific notation.
      .replace(/^([+-]?[\d.]+e)(?:\+|(-))?0*(\d)/, "$1$2$3")
      // Remove unnecessary scientific notation (1e0).
      .replace(/^([+-]?[\d.]+)e[+-]?0+$/, "$1")
      // Make sure numbers always start with a digit.
      .replace(/^([+-])?\./, "$10.")
      // Remove extraneous trailing decimal zeroes.
      .replace(/(\.\d+?)0+(?=e|$)/, "$1")
      // Remove trailing dot.
      .replace(/\.(?=e|$)/, "")
  );
}

/**
 * @param {string} str
 * @param {string} target
 * @returns {number}
 */
function getMaxContinuousCount(str, target) {
  const results = str.match(
    new RegExp(`(${escapeStringRegexp(target)})+`, "g")
  );

  if (results === null) {
    return 0;
  }

  return results.reduce(
    (maxCount, result) => Math.max(maxCount, result.length / target.length),
    0
  );
}

function getMinNotPresentContinuousCount(str, target) {
  const matches = str.match(
    new RegExp(`(${escapeStringRegexp(target)})+`, "g")
  );

  if (matches === null) {
    return 0;
  }

  const countPresent = new Map();
  let max = 0;

  for (const match of matches) {
    const count = match.length / target.length;
    countPresent.set(count, true);
    if (count > max) {
      max = count;
    }
  }

  for (let i = 1; i < max; i++) {
    if (!countPresent.get(i)) {
      return i;
    }
  }

  return max + 1;
}

function addCommentHelper(node, comment) {
  const comments = (node.comments ??= []);
  comments.push(comment);
  comment.printed = false;
  comment.nodeDescription = describeNodeForDebugging(node);
}

function addLeadingComment(node, comment) {
  comment.leading = true;
  comment.trailing = false;
  addCommentHelper(node, comment);
}

function addDanglingComment(node, comment, marker) {
  comment.leading = false;
  comment.trailing = false;
  if (marker) {
    comment.marker = marker;
  }
  addCommentHelper(node, comment);
}

function addTrailingComment(node, comment) {
  comment.leading = false;
  comment.trailing = true;
  addCommentHelper(node, comment);
}

function isFrontMatterNode(node) {
  return node && node.type === "front-matter";
}

/**
 * @param {string} description
 * @returns {(node: any) => symbol}
 */
function createGroupIdMapper(description) {
  const groupIds = new WeakMap();
  return function (node) {
    if (!groupIds.has(node)) {
      groupIds.set(node, Symbol(description));
    }
    return groupIds.get(node);
  };
}

function describeNodeForDebugging(node) {
  const nodeType = node.type || node.kind || "(unknown type)";
  let nodeName = String(
    node.name ||
      (node.id && (typeof node.id === "object" ? node.id.name : node.id)) ||
      (node.key && (typeof node.key === "object" ? node.key.name : node.key)) ||
      (node.value &&
        (typeof node.value === "object" ? "" : String(node.value))) ||
      node.operator ||
      ""
  );
  if (nodeName.length > 20) {
    nodeName = nodeName.slice(0, 19) + "…";
  }
  return nodeType + (nodeName ? " " + nodeName : "");
}

export {
  getMaxContinuousCount,
  getMinNotPresentContinuousCount,
  getNextNonSpaceNonCommentCharacterIndexWithStartIndex,
  getNextNonSpaceNonCommentCharacterIndex,
  getNextNonSpaceNonCommentCharacter,
  skip,
  skipWhitespace,
  skipSpaces,
  skipToLineEnd,
  skipEverythingButNewLine,
  skipInlineComment,
  skipTrailingComment,
  skipNewline,
  isNextLineEmptyAfterIndex,
  isNextLineEmpty,
  isPreviousLineEmpty,
  hasNewline,
  hasNewlineInRange,
  hasSpaces,
  getAlignmentSize,
  getIndentSize,
  getPreferredQuote,
  printString,
  printNumber,
  makeString,
  addLeadingComment,
  addDanglingComment,
  addTrailingComment,
  isFrontMatterNode,
  createGroupIdMapper,
};
export { default as isNonEmptyArray } from "../utils/is-non-empty-array.js";
export { default as getStringWidth } from "../utils/get-string-width.js";
