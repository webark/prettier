import { printDanglingComments } from "../../main/comments.js";
import {
  line,
  softline,
  hardline,
  group,
  indent,
  ifBreak,
  fill,
} from "../../document/builders.js";
import { hasNewline } from "../../common/util.js";
import {
  shouldPrintComma,
  hasComment,
  CommentCheckFlags,
  isNextLineEmpty,
  isNumericLiteral,
  isSignedNumericLiteral,
} from "../utils/index.js";
import { locStart } from "../loc.js";

import { printOptionalToken, printTypeAnnotation } from "./misc.js";

/** @typedef {import("../../document/builders.js").Doc} Doc */

function printEmptyArray(path, openBracket, closeBracket, options) {
  const { node } = path;
  if (!hasComment(node, CommentCheckFlags.Dangling)) {
    return [openBracket, closeBracket];
  }
  return group([
    openBracket,
    printDanglingComments(path, options),
    softline,
    closeBracket,
  ]);
}

function printArray(path, options, print) {
  const { node } = path;
  /** @type{Doc[]} */
  const parts = [];

  const openBracket = node.type === "TupleExpression" ? "#[" : "[";
  const closeBracket = "]";
  if (node.elements.length === 0) {
    parts.push(printEmptyArray(path, openBracket, closeBracket, options));
  } else {
    const lastElem = node.elements.at(-1);
    const canHaveTrailingComma = !(lastElem && lastElem.type === "RestElement");

    // JavaScript allows you to have empty elements in an array which
    // changes its length based on the number of commas. The algorithm
    // is that if the last argument is null, we need to force insert
    // a comma to ensure JavaScript recognizes it.
    //   [,].length === 1
    //   [1,].length === 1
    //   [1,,].length === 2
    //
    // Note that getLast returns null if the array is empty, but
    // we already check for an empty array just above so we are safe
    const needsForcedTrailingComma = lastElem === null;

    const groupId = Symbol("array");

    const shouldBreak =
      !options.__inJestEach &&
      node.elements.length > 1 &&
      node.elements.every((element, i, elements) => {
        const elementType = element && element.type;
        if (
          elementType !== "ArrayExpression" &&
          elementType !== "ObjectExpression"
        ) {
          return false;
        }

        const nextElement = elements[i + 1];
        if (nextElement && elementType !== nextElement.type) {
          return false;
        }

        const itemsKey =
          elementType === "ArrayExpression" ? "elements" : "properties";

        return element[itemsKey] && element[itemsKey].length > 1;
      });

    const shouldUseConciseFormatting = isConciselyPrintedArray(node, options);

    const trailingComma = !canHaveTrailingComma
      ? ""
      : needsForcedTrailingComma
      ? ","
      : !shouldPrintComma(options)
      ? ""
      : shouldUseConciseFormatting
      ? ifBreak(",", "", { groupId })
      : ifBreak(",");

    parts.push(
      group(
        [
          openBracket,
          indent([
            softline,
            shouldUseConciseFormatting
              ? printArrayItemsConcisely(path, options, print, trailingComma)
              : [
                  printArrayItems(path, options, "elements", print),
                  trailingComma,
                ],
            printDanglingComments(path, options, /* sameIndent */ true),
          ]),
          softline,
          closeBracket,
        ],
        { shouldBreak, id: groupId }
      )
    );
  }

  parts.push(
    printOptionalToken(path),
    printTypeAnnotation(path, options, print)
  );

  return parts;
}

function isConciselyPrintedArray(node, options) {
  return (
    node.elements.length > 1 &&
    node.elements.every(
      (element) =>
        element &&
        (isNumericLiteral(element) ||
          (isSignedNumericLiteral(element) && !hasComment(element.argument))) &&
        !hasComment(
          element,
          CommentCheckFlags.Trailing | CommentCheckFlags.Line,
          (comment) =>
            !hasNewline(options.originalText, locStart(comment), {
              backwards: true,
            })
        )
    )
  );
}

function printArrayItems(path, options, printPath, print) {
  const printedElements = [];
  let separatorParts = [];

  path.each((childPath) => {
    printedElements.push(separatorParts, group(print()));

    separatorParts = [",", line];
    if (childPath.node && isNextLineEmpty(childPath.node, options)) {
      separatorParts.push(softline);
    }
  }, printPath);

  return printedElements;
}

function printArrayItemsConcisely(path, options, print, trailingComma) {
  const parts = [];

  path.each((childPath, i, elements) => {
    const isLast = i === elements.length - 1;

    parts.push([print(), isLast ? trailingComma : ","]);

    if (!isLast) {
      parts.push(
        isNextLineEmpty(childPath.node, options)
          ? [hardline, hardline]
          : hasComment(
              elements[i + 1],
              CommentCheckFlags.Leading | CommentCheckFlags.Line
            )
          ? hardline
          : line
      );
    }
  }, "elements");

  return fill(parts);
}

export {
  printArray,
  printArrayItems,
  isConciselyPrintedArray,
  printEmptyArray,
};
