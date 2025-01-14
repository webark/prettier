import {
  getMinNotPresentContinuousCount,
  getMaxContinuousCount,
  getStringWidth,
} from "../common/util.js";
import {
  breakParent,
  join,
  line,
  literalline,
  markAsRoot,
  hardline,
  softline,
  ifBreak,
  fill,
  align,
  indent,
  group,
  hardlineWithoutBreakParent,
} from "../document/builders.js";
import { normalizeDoc, replaceEndOfLine } from "../document/utils.js";
import { printDocToString } from "../document/printer.js";
import createGetVisitorKeys from "../utils/create-get-visitor-keys.js";
import UnexpectedNodeError from "../utils/unexpected-node-error.js";
import embed from "./embed.js";
import { insertPragma } from "./pragma.js";
import { locStart, locEnd } from "./loc.js";
import preprocess from "./print-preprocess.js";
import clean from "./clean.js";
import {
  getFencedCodeBlockValue,
  hasGitDiffFriendlyOrderedList,
  splitText,
  punctuationPattern,
  INLINE_NODE_TYPES,
  INLINE_NODE_WRAPPER_TYPES,
  isAutolink,
  getAncestorNode,
  getAncestorCounter,
} from "./utils.js";
import visitorKeys from "./visitor-keys.js";
import { printWhitespace } from "./print-whitespace.js";

const getVisitorKeys = createGetVisitorKeys(visitorKeys);

/**
 * @typedef {import("../document/builders.js").Doc} Doc
 */

const SIBLING_NODE_TYPES = new Set([
  "listItem",
  "definition",
  "footnoteDefinition",
]);

function genericPrint(path, options, print) {
  const { node } = path;

  if (shouldRemainTheSameContent(path)) {
    return splitText(
      options.originalText.slice(
        node.position.start.offset,
        node.position.end.offset
      )
    ).map((node) =>
      node.type === "word"
        ? node.value
        : printWhitespace(path, node.value, options.proseWrap, true)
    );
  }

  switch (node.type) {
    case "front-matter":
      return options.originalText.slice(
        node.position.start.offset,
        node.position.end.offset
      );
    case "root":
      /* c8 ignore next 3 */
      if (node.children.length === 0) {
        return "";
      }
      return [normalizeDoc(printRoot(path, options, print)), hardline];
    case "paragraph":
      return printChildren(path, options, print, {
        postprocessor: fill,
      });
    case "sentence":
      return printChildren(path, options, print);
    case "word": {
      let escapedValue = node.value
        .replace(/\*/g, "\\$&") // escape all `*`
        .replace(
          new RegExp(
            [
              `(^|${punctuationPattern})(_+)`,
              `(_+)(${punctuationPattern}|$)`,
            ].join("|"),
            "g"
          ),
          (_, text1, underscore1, underscore2, text2) =>
            (underscore1
              ? `${text1}${underscore1}`
              : `${underscore2}${text2}`
            ).replace(/_/g, "\\_")
        ); // escape all `_` except concating with non-punctuation, e.g. `1_2_3` is not considered emphasis

      const isFirstSentence = (node, name, index) =>
        node.type === "sentence" && index === 0;
      const isLastChildAutolink = (node, name, index) =>
        isAutolink(node.children[index - 1]);

      if (
        escapedValue !== node.value &&
        (path.match(undefined, isFirstSentence, isLastChildAutolink) ||
          path.match(
            undefined,
            isFirstSentence,
            (node, name, index) => node.type === "emphasis" && index === 0,
            isLastChildAutolink
          ))
      ) {
        // backslash is parsed as part of autolinks, so we need to remove it
        escapedValue = escapedValue.replace(/^(\\?[*_])+/, (prefix) =>
          prefix.replace(/\\/g, "")
        );
      }

      return escapedValue;
    }
    case "whitespace": {
      const { next } = path;

      const proseWrap =
        // leading char that may cause different syntax
        next && /^>|^(?:[*+-]|#{1,6}|\d+[).])$/.test(next.value)
          ? "never"
          : options.proseWrap;

      return printWhitespace(path, node.value, proseWrap);
    }
    case "emphasis": {
      let style;
      if (isAutolink(node.children[0])) {
        style = options.originalText[node.position.start.offset];
      } else {
        const { previous, next } = path;
        const hasPrevOrNextWord = // `1*2*3` is considered emphasis but `1_2_3` is not
          (previous?.type === "sentence" &&
            previous.children.at(-1)?.type === "word" &&
            !previous.children.at(-1).hasTrailingPunctuation) ||
          (next?.type === "sentence" &&
            next.children[0]?.type === "word" &&
            !next.children[0].hasLeadingPunctuation);
        style =
          hasPrevOrNextWord || getAncestorNode(path, "emphasis") ? "*" : "_";
      }
      return [style, printChildren(path, options, print), style];
    }
    case "strong":
      return ["**", printChildren(path, options, print), "**"];
    case "delete":
      return ["~~", printChildren(path, options, print), "~~"];
    case "inlineCode": {
      const code =
        options.proseWrap === "preserve"
          ? node.value
          : node.value.replace(/\n/g, " ");
      const backtickCount = getMinNotPresentContinuousCount(code, "`");
      const backtickString = "`".repeat(backtickCount || 1);
      const padding =
        code.startsWith("`") ||
        code.endsWith("`") ||
        (/^[\n ]/.test(code) && /[\n ]$/.test(code) && /[^\n ]/.test(code))
          ? " "
          : "";
      return [backtickString, padding, code, padding, backtickString];
    }
    case "wikiLink": {
      let contents = "";
      if (options.proseWrap === "preserve") {
        contents = node.value;
      } else {
        contents = node.value.replace(/[\t\n]+/g, " ");
      }

      return ["[[", contents, "]]"];
    }
    case "link":
      switch (options.originalText[node.position.start.offset]) {
        case "<": {
          const mailto = "mailto:";
          const url =
            // <hello@example.com> is parsed as { url: "mailto:hello@example.com" }
            node.url.startsWith(mailto) &&
            options.originalText.slice(
              node.position.start.offset + 1,
              node.position.start.offset + 1 + mailto.length
            ) !== mailto
              ? node.url.slice(mailto.length)
              : node.url;
          return ["<", url, ">"];
        }
        case "[":
          return [
            "[",
            printChildren(path, options, print),
            "](",
            printUrl(node.url, ")"),
            printTitle(node.title, options),
            ")",
          ];
        default:
          return options.originalText.slice(
            node.position.start.offset,
            node.position.end.offset
          );
      }
    case "image":
      return [
        "![",
        node.alt || "",
        "](",
        printUrl(node.url, ")"),
        printTitle(node.title, options),
        ")",
      ];
    case "blockquote":
      return ["> ", align("> ", printChildren(path, options, print))];
    case "heading":
      return [
        "#".repeat(node.depth) + " ",
        printChildren(path, options, print),
      ];
    case "code": {
      if (node.isIndented) {
        // indented code block
        const alignment = " ".repeat(4);
        return align(alignment, [
          alignment,
          replaceEndOfLine(node.value, hardline),
        ]);
      }

      // fenced code block
      const styleUnit = options.__inJsTemplate ? "~" : "`";
      const style = styleUnit.repeat(
        Math.max(3, getMaxContinuousCount(node.value, styleUnit) + 1)
      );
      return [
        style,
        node.lang || "",
        node.meta ? " " + node.meta : "",
        hardline,
        replaceEndOfLine(
          getFencedCodeBlockValue(node, options.originalText),
          hardline
        ),
        hardline,
        style,
      ];
    }
    case "html": {
      const { parent } = path;
      const value =
        parent.type === "root" && parent.children.at(-1) === node
          ? node.value.trimEnd()
          : node.value;
      const isHtmlComment = /^<!--.*-->$/s.test(value);

      return replaceEndOfLine(
        value,
        // @ts-expect-error
        isHtmlComment ? hardline : markAsRoot(literalline)
      );
    }
    case "list": {
      const nthSiblingIndex = getNthListSiblingIndex(node, path.parent);

      const isGitDiffFriendlyOrderedList = hasGitDiffFriendlyOrderedList(
        node,
        options
      );

      return printChildren(path, options, print, {
        processor(childPath, index) {
          const prefix = getPrefix();
          const childNode = childPath.node;

          if (
            childNode.children.length === 2 &&
            childNode.children[1].type === "html" &&
            childNode.children[0].position.start.column !==
              childNode.children[1].position.start.column
          ) {
            return [prefix, printListItem(childPath, options, print, prefix)];
          }

          return [
            prefix,
            align(
              " ".repeat(prefix.length),
              printListItem(childPath, options, print, prefix)
            ),
          ];

          function getPrefix() {
            const rawPrefix = node.ordered
              ? (index === 0
                  ? node.start
                  : isGitDiffFriendlyOrderedList
                  ? 1
                  : node.start + index) +
                (nthSiblingIndex % 2 === 0 ? ". " : ") ")
              : nthSiblingIndex % 2 === 0
              ? "- "
              : "* ";

            return node.isAligned ||
              /* workaround for https://github.com/remarkjs/remark/issues/315 */ node.hasIndentedCodeblock
              ? alignListPrefix(rawPrefix, options)
              : rawPrefix;
          }
        },
      });
    }
    case "thematicBreak": {
      const counter = getAncestorCounter(path, "list");
      if (counter === -1) {
        return "---";
      }
      const nthSiblingIndex = getNthListSiblingIndex(
        path.getParentNode(counter),
        path.getParentNode(counter + 1)
      );
      return nthSiblingIndex % 2 === 0 ? "***" : "---";
    }
    case "linkReference":
      return [
        "[",
        printChildren(path, options, print),
        "]",
        node.referenceType === "full"
          ? ["[", node.identifier, "]"]
          : node.referenceType === "collapsed"
          ? "[]"
          : "",
      ];
    case "imageReference":
      switch (node.referenceType) {
        case "full":
          return ["![", node.alt || "", "][", node.identifier, "]"];
        default:
          return [
            "![",
            node.alt,
            "]",
            node.referenceType === "collapsed" ? "[]" : "",
          ];
      }
    case "definition": {
      const lineOrSpace = options.proseWrap === "always" ? line : " ";
      return group([
        "[",
        node.identifier,
        "]:",
        indent([
          lineOrSpace,
          printUrl(node.url),
          node.title === null
            ? ""
            : [lineOrSpace, printTitle(node.title, options, false)],
        ]),
      ]);
    }
    // `footnote` requires `.use(footnotes, {inlineNotes: true})`, we are not using this option
    // https://github.com/remarkjs/remark-footnotes#optionsinlinenotes
    /* c8 ignore next 2 */
    case "footnote":
      return ["[^", printChildren(path, options, print), "]"];
    case "footnoteReference":
      return ["[^", node.identifier, "]"];
    case "footnoteDefinition": {
      const shouldInlineFootnote =
        node.children.length === 1 &&
        node.children[0].type === "paragraph" &&
        (options.proseWrap === "never" ||
          (options.proseWrap === "preserve" &&
            node.children[0].position.start.line ===
              node.children[0].position.end.line));
      return [
        "[^",
        node.identifier,
        "]: ",
        shouldInlineFootnote
          ? printChildren(path, options, print)
          : group([
              align(
                " ".repeat(4),
                printChildren(path, options, print, {
                  processor: (childPath, index) =>
                    index === 0 ? group([softline, print()]) : print(),
                })
              ),
              path.next?.type === "footnoteDefinition" ? softline : "",
            ]),
      ];
    }
    case "table":
      return printTable(path, options, print);
    case "tableCell":
      return printChildren(path, options, print);
    case "break":
      return /\s/.test(options.originalText[node.position.start.offset])
        ? ["  ", markAsRoot(literalline)]
        : ["\\", hardline];
    case "liquidNode":
      return replaceEndOfLine(node.value, hardline);
    // MDX
    // fallback to the original text if multiparser failed
    // or `embeddedLanguageFormatting: "off"`
    case "import":
    case "export":
    case "jsx":
      return node.value;
    case "esComment":
      return ["{/* ", node.value, " */}"];
    case "math":
      return [
        "$$",
        hardline,
        node.value ? [replaceEndOfLine(node.value, hardline), hardline] : "",
        "$$",
      ];
    case "inlineMath":
      // remark-math trims content but we don't want to remove whitespaces
      // since it's very possible that it's recognized as math accidentally
      return options.originalText.slice(locStart(node), locEnd(node));

    case "tableRow": // handled in "table"
    case "listItem": // handled in "list"
    case "text": // handled in other types
    default:
      /* c8 ignore next */
      throw new UnexpectedNodeError(node, "Markdown");
  }
}

function printListItem(path, options, print, listPrefix) {
  const { node } = path;
  const prefix = node.checked === null ? "" : node.checked ? "[x] " : "[ ] ";
  return [
    prefix,
    printChildren(path, options, print, {
      processor(childPath, index) {
        if (index === 0 && childPath.node.type !== "list") {
          return align(" ".repeat(prefix.length), print());
        }

        const alignment = " ".repeat(
          clamp(options.tabWidth - listPrefix.length, 0, 3) // 4+ will cause indented code block
        );
        return [alignment, align(alignment, print())];
      },
    }),
  ];
}

function alignListPrefix(prefix, options) {
  const additionalSpaces = getAdditionalSpaces();
  return (
    prefix +
    " ".repeat(
      additionalSpaces >= 4 ? 0 : additionalSpaces // 4+ will cause indented code block
    )
  );

  function getAdditionalSpaces() {
    const restSpaces = prefix.length % options.tabWidth;
    return restSpaces === 0 ? 0 : options.tabWidth - restSpaces;
  }
}

function getNthListSiblingIndex(node, parentNode) {
  return getNthSiblingIndex(
    node,
    parentNode,
    (siblingNode) => siblingNode.ordered === node.ordered
  );
}

function getNthSiblingIndex(node, parentNode, condition) {
  let index = -1;

  for (const childNode of parentNode.children) {
    if (childNode.type === node.type && condition(childNode)) {
      index++;
    } else {
      index = -1;
    }

    if (childNode === node) {
      return index;
    }
  }
}

function printTable(path, options, print) {
  const { node } = path;

  const columnMaxWidths = [];
  // { [rowIndex: number]: { [columnIndex: number]: {text: string, width: number} } }
  const contents = path.map(
    (rowPath) =>
      rowPath.map((cellPath, columnIndex) => {
        const text = printDocToString(print(), options).formatted;
        const width = getStringWidth(text);
        columnMaxWidths[columnIndex] = Math.max(
          columnMaxWidths[columnIndex] || 3, // minimum width = 3 (---, :--, :-:, --:)
          width
        );
        return { text, width };
      }, "children"),
    "children"
  );

  const alignedTable = printTableContents(/* isCompact */ false);
  if (options.proseWrap !== "never") {
    return [breakParent, alignedTable];
  }

  // Only if the --prose-wrap never is set and it exceeds the print width.
  const compactTable = printTableContents(/* isCompact */ true);
  return [breakParent, group(ifBreak(compactTable, alignedTable))];

  function printTableContents(isCompact) {
    /** @type{Doc[]} */
    const parts = [printRow(contents[0], isCompact), printAlign(isCompact)];
    if (contents.length > 1) {
      parts.push(
        join(
          hardlineWithoutBreakParent,
          contents
            .slice(1)
            .map((rowContents) => printRow(rowContents, isCompact))
        )
      );
    }
    return join(hardlineWithoutBreakParent, parts);
  }

  function printAlign(isCompact) {
    const align = columnMaxWidths.map((width, index) => {
      const align = node.align[index];
      const first = align === "center" || align === "left" ? ":" : "-";
      const last = align === "center" || align === "right" ? ":" : "-";
      const middle = isCompact ? "-" : "-".repeat(width - 2);
      return `${first}${middle}${last}`;
    });

    return `| ${align.join(" | ")} |`;
  }

  function printRow(rowContents, isCompact) {
    const columns = rowContents.map(({ text, width }, columnIndex) => {
      if (isCompact) {
        return text;
      }
      const spaces = columnMaxWidths[columnIndex] - width;
      const align = node.align[columnIndex];
      let before = 0;
      if (align === "right") {
        before = spaces;
      } else if (align === "center") {
        before = Math.floor(spaces / 2);
      }
      const after = spaces - before;
      return `${" ".repeat(before)}${text}${" ".repeat(after)}`;
    });

    return `| ${columns.join(" | ")} |`;
  }
}

function printRoot(path, options, print) {
  /** @typedef {{ index: number, offset: number }} IgnorePosition */
  /** @type {Array<{start: IgnorePosition, end: IgnorePosition}>} */
  const ignoreRanges = [];

  /** @type {IgnorePosition | null} */
  let ignoreStart = null;

  const { children } = path.node;
  for (const [index, childNode] of children.entries()) {
    switch (isPrettierIgnore(childNode)) {
      case "start":
        if (ignoreStart === null) {
          ignoreStart = { index, offset: childNode.position.end.offset };
        }
        break;
      case "end":
        if (ignoreStart !== null) {
          ignoreRanges.push({
            start: ignoreStart,
            end: { index, offset: childNode.position.start.offset },
          });
          ignoreStart = null;
        }
        break;
      default:
        // do nothing
        break;
    }
  }

  return printChildren(path, options, print, {
    processor(childPath, index) {
      if (ignoreRanges.length > 0) {
        const ignoreRange = ignoreRanges[0];

        if (index === ignoreRange.start.index) {
          return [
            printIgnoreComment(children[ignoreRange.start.index]),
            options.originalText.slice(
              ignoreRange.start.offset,
              ignoreRange.end.offset
            ),
            printIgnoreComment(children[ignoreRange.end.index]),
          ];
        }

        if (ignoreRange.start.index < index && index < ignoreRange.end.index) {
          return false;
        }

        if (index === ignoreRange.end.index) {
          ignoreRanges.shift();
          return false;
        }
      }

      return print();
    },
  });
}

function printChildren(path, options, print, events = {}) {
  const { postprocessor } = events;
  const processor = events.processor || (() => print());

  const { node } = path;
  const parts = [];

  let lastChildNode;

  path.each((childPath, index) => {
    const childNode = childPath.node;

    const result = processor(childPath, index);
    if (result !== false) {
      const data = {
        parts,
        prevNode: lastChildNode,
        parentNode: node,
        options,
      };

      if (shouldPrePrintHardline(childNode, data)) {
        parts.push(hardline);

        if (
          shouldPrePrintDoubleHardline(childNode, data) ||
          shouldPrePrintTripleHardline(childNode, data)
        ) {
          parts.push(hardline);
        }

        if (shouldPrePrintTripleHardline(childNode, data)) {
          parts.push(hardline);
        }
      }

      parts.push(result);

      lastChildNode = childNode;
    }
  }, "children");

  return postprocessor ? postprocessor(parts) : parts;
}

function printIgnoreComment(node) {
  if (node.type === "html") {
    return node.value;
  }

  if (
    node.type === "paragraph" &&
    Array.isArray(node.children) &&
    node.children.length === 1 &&
    node.children[0].type === "esComment"
  ) {
    return ["{/* ", node.children[0].value, " */}"];
  }
}

/** @return {false | 'next' | 'start' | 'end'} */
function isPrettierIgnore(node) {
  let match;

  if (node.type === "html") {
    match = node.value.match(/^<!--\s*prettier-ignore(?:-(start|end))?\s*-->$/);
  } else {
    let comment;

    if (node.type === "esComment") {
      comment = node;
    } else if (
      node.type === "paragraph" &&
      node.children.length === 1 &&
      node.children[0].type === "esComment"
    ) {
      comment = node.children[0];
    }

    if (comment) {
      match = comment.value.match(/^prettier-ignore(?:-(start|end))?$/);
    }
  }

  return match ? match[1] || "next" : false;
}

function shouldPrePrintHardline(node, data) {
  const isFirstNode = data.parts.length === 0;
  const isInlineNode = INLINE_NODE_TYPES.includes(node.type);

  const isInlineHTML =
    node.type === "html" &&
    INLINE_NODE_WRAPPER_TYPES.includes(data.parentNode.type);

  return !isFirstNode && !isInlineNode && !isInlineHTML;
}

function shouldPrePrintDoubleHardline(node, data) {
  const isSequence = (data.prevNode && data.prevNode.type) === node.type;
  const isSiblingNode = isSequence && SIBLING_NODE_TYPES.has(node.type);

  const isInTightListItem =
    data.parentNode.type === "listItem" && !data.parentNode.loose;

  const isPrevNodeLooseListItem =
    data.prevNode?.type === "listItem" && data.prevNode.loose;

  const isPrevNodePrettierIgnore = isPrettierIgnore(data.prevNode) === "next";

  const isBlockHtmlWithoutBlankLineBetweenPrevHtml =
    node.type === "html" &&
    data.prevNode?.type === "html" &&
    data.prevNode.position.end.line + 1 === node.position.start.line;

  const isHtmlDirectAfterListItem =
    node.type === "html" &&
    data.parentNode.type === "listItem" &&
    data.prevNode?.type === "paragraph" &&
    data.prevNode.position.end.line + 1 === node.position.start.line;

  return (
    isPrevNodeLooseListItem ||
    !(
      isSiblingNode ||
      isInTightListItem ||
      isPrevNodePrettierIgnore ||
      isBlockHtmlWithoutBlankLineBetweenPrevHtml ||
      isHtmlDirectAfterListItem
    )
  );
}

function shouldPrePrintTripleHardline(node, data) {
  const isPrevNodeList = data.prevNode?.type === "list";
  const isIndentedCode = node.type === "code" && node.isIndented;

  return isPrevNodeList && isIndentedCode;
}

function shouldRemainTheSameContent(path) {
  const ancestorNode = getAncestorNode(path, [
    "linkReference",
    "imageReference",
  ]);

  return (
    ancestorNode &&
    (ancestorNode.type !== "linkReference" ||
      ancestorNode.referenceType !== "full")
  );
}

/**
 * @param {string} url
 * @param {string[] | string} [dangerousCharOrChars]
 * @returns {string}
 */
function printUrl(url, dangerousCharOrChars = []) {
  const dangerousChars = [
    " ",
    ...(Array.isArray(dangerousCharOrChars)
      ? dangerousCharOrChars
      : [dangerousCharOrChars]),
  ];
  return new RegExp(dangerousChars.map((x) => `\\${x}`).join("|")).test(url)
    ? `<${url}>`
    : url;
}

function printTitle(title, options, printSpace = true) {
  if (!title) {
    return "";
  }
  if (printSpace) {
    return " " + printTitle(title, options, false);
  }

  // title is escaped after `remark-parse` v7
  title = title.replace(/\\(["')])/g, "$1");

  if (title.includes('"') && title.includes("'") && !title.includes(")")) {
    return `(${title})`; // avoid escaped quotes
  }
  // faster than using RegExps: https://jsperf.com/performance-of-match-vs-split
  const singleCount = title.split("'").length - 1;
  const doubleCount = title.split('"').length - 1;
  const quote =
    singleCount > doubleCount
      ? '"'
      : doubleCount > singleCount
      ? "'"
      : options.singleQuote
      ? "'"
      : '"';
  title = title.replace(/\\/, "\\\\");
  title = title.replace(new RegExp(`(${quote})`, "g"), "\\$1");
  return `${quote}${title}${quote}`;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function hasPrettierIgnore(path) {
  return path.index > 0 && isPrettierIgnore(path.previous) === "next";
}

const printer = {
  preprocess,
  print: genericPrint,
  embed,
  massageAstNode: clean,
  hasPrettierIgnore,
  insertPragma,
  getVisitorKeys,
};

export default printer;
