/** @typedef {import("../../document/builders.js").Doc} Doc */

import assert from "node:assert";
import {
  printDanglingComments,
  printCommentsSeparately,
} from "../../main/comments.js";
import { getNextNonSpaceNonCommentCharacterIndex } from "../../common/util.js";
import {
  line,
  softline,
  group,
  indent,
  dedent,
  ifBreak,
  hardline,
  join,
  indentIfBreak,
} from "../../document/builders.js";
import { removeLines, willBreak } from "../../document/utils.js";
import { ArgExpansionBailout } from "../../common/errors.js";
import {
  getFunctionParameters,
  hasLeadingOwnLineComment,
  isJsxNode,
  isTemplateOnItsOwnLine,
  shouldPrintComma,
  startsWithNoLookaheadToken,
  isBinaryish,
  isLineComment,
  hasComment,
  getComments,
  CommentCheckFlags,
  isCallLikeExpression,
  isCallExpression,
  getCallArguments,
  hasNakedLeftSide,
  getLeftSide,
} from "../utils/index.js";
import { locEnd } from "../loc.js";
import {
  printFunctionParameters,
  shouldGroupFunctionParameters,
} from "./function-parameters.js";
import { printPropertyKey } from "./property.js";
import { printFunctionTypeParameters } from "./misc.js";

function printFunction(path, print, options, args) {
  const { node } = path;

  let expandArg = false;
  if (
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression") &&
    args?.expandLastArg
  ) {
    const { parent } = path;
    if (
      isCallExpression(parent) &&
      (getCallArguments(parent).length > 1 ||
        getFunctionParameters(node).every(
          (param) => param.type === "Identifier" && !param.typeAnnotation
        ))
    ) {
      expandArg = true;
    }
  }

  const parts = [];

  // For TypeScript the TSDeclareFunction node shares the AST
  // structure with FunctionDeclaration
  if (node.type === "TSDeclareFunction" && node.declare) {
    parts.push("declare ");
  }

  if (node.async) {
    parts.push("async ");
  }

  if (node.generator) {
    parts.push("function* ");
  } else {
    parts.push("function ");
  }

  if (node.id) {
    parts.push(print("id"));
  }

  const parametersDoc = printFunctionParameters(
    path,
    print,
    options,
    expandArg
  );
  const returnTypeDoc = printReturnType(path, print);
  const shouldGroupParameters = shouldGroupFunctionParameters(
    node,
    returnTypeDoc
  );

  parts.push(
    printFunctionTypeParameters(path, options, print),
    group([
      shouldGroupParameters ? group(parametersDoc) : parametersDoc,
      returnTypeDoc,
    ]),
    node.body ? " " : "",
    print("body")
  );

  if (options.semi && (node.declare || !node.body)) {
    parts.push(";");
  }

  return parts;
}

function printMethod(path, options, print) {
  const { node } = path;
  const { kind } = node;
  const value = node.value || node;
  const parts = [];

  if (!kind || kind === "init" || kind === "method" || kind === "constructor") {
    if (value.async) {
      parts.push("async ");
    }
  } else {
    assert.ok(kind === "get" || kind === "set");

    parts.push(kind, " ");
  }

  // A `getter`/`setter` can't be a generator, but it's recoverable
  if (value.generator) {
    parts.push("*");
  }

  parts.push(
    printPropertyKey(path, options, print),
    node.optional || node.key.optional ? "?" : ""
  );

  if (node === value) {
    parts.push(printMethodInternal(path, options, print));
  } else if (value.type === "FunctionExpression") {
    parts.push(
      path.call((path) => printMethodInternal(path, options, print), "value")
    );
  } else {
    parts.push(print("value"));
  }

  return parts;
}

function printMethodInternal(path, options, print) {
  const { node } = path;
  const parametersDoc = printFunctionParameters(path, print, options);
  const returnTypeDoc = printReturnType(path, print);
  const shouldGroupParameters = shouldGroupFunctionParameters(
    node,
    returnTypeDoc
  );
  const parts = [
    printFunctionTypeParameters(path, options, print),
    group([
      shouldGroupParameters ? group(parametersDoc) : parametersDoc,
      returnTypeDoc,
    ]),
  ];

  if (node.body) {
    parts.push(" ", print("body"));
  } else {
    parts.push(options.semi ? ";" : "");
  }

  return parts;
}

function printArrowFunctionSignature(path, options, print, args) {
  const { node } = path;
  const parts = [];

  if (node.async) {
    parts.push("async ");
  }

  if (shouldPrintParamsWithoutParens(path, options)) {
    parts.push(print(["params", 0]));
  } else {
    const expandArg = args && (args.expandLastArg || args.expandFirstArg);
    let returnTypeDoc = printReturnType(path, print);
    if (expandArg) {
      if (willBreak(returnTypeDoc)) {
        throw new ArgExpansionBailout();
      }
      returnTypeDoc = group(removeLines(returnTypeDoc));
    }
    parts.push(
      group([
        printFunctionParameters(
          path,
          print,
          options,
          expandArg,
          /* printTypeParams */ true
        ),
        returnTypeDoc,
      ])
    );
  }

  const dangling = printDanglingComments(
    path,
    options,
    /* sameIndent */ true,
    (comment) => {
      const nextCharacter = getNextNonSpaceNonCommentCharacterIndex(
        options.originalText,
        comment,
        locEnd
      );
      return (
        nextCharacter !== false &&
        options.originalText.slice(nextCharacter, nextCharacter + 2) === "=>"
      );
    }
  );
  if (dangling) {
    parts.push(" ", dangling);
  }
  return parts;
}

function printArrowChain(
  path,
  args,
  signatures,
  shouldBreak,
  bodyDoc,
  tailNode
) {
  const name = path.getName();
  const { parent } = path;
  const isCallee = isCallLikeExpression(parent) && name === "callee";
  const isAssignmentRhs = Boolean(args && args.assignmentLayout);
  const shouldPutBodyOnSeparateLine =
    tailNode.body.type !== "BlockStatement" &&
    tailNode.body.type !== "ObjectExpression" &&
    tailNode.body.type !== "SequenceExpression";
  const shouldBreakBeforeChain =
    (isCallee && shouldPutBodyOnSeparateLine) ||
    (args && args.assignmentLayout === "chain-tail-arrow-chain");

  const groupId = Symbol("arrow-chain");

  if ((isCallLikeExpression(parent) && !isCallee) || isBinaryish(parent)) {
    signatures = [dedent(signatures[0]), ...signatures.slice(1)];
  }

  // We handle sequence expressions as the body of arrows specially,
  // so that the required parentheses end up on their own lines.
  if (tailNode.body.type === "SequenceExpression") {
    bodyDoc = group(["(", indent([softline, bodyDoc]), softline, ")"]);
  }

  return group([
    group(
      indent([
        isCallee || isAssignmentRhs ? softline : "",
        group(join([" =>", line], signatures), { shouldBreak }),
      ]),
      { id: groupId, shouldBreak: shouldBreakBeforeChain }
    ),
    " =>",
    indentIfBreak(
      shouldPutBodyOnSeparateLine ? indent([line, bodyDoc]) : [" ", bodyDoc],
      { groupId }
    ),
    isCallee ? ifBreak(softline, "", { groupId }) : "",
  ]);
}

function printArrowFunction(path, options, print, args) {
  let { node } = path;
  /** @type {Doc[]} */
  const signatures = [];
  const body = [];
  let chainShouldBreak = false;

  (function rec() {
    const doc = printArrowFunctionSignature(path, options, print, args);
    if (signatures.length === 0) {
      signatures.push(doc);
    } else {
      const { leading, trailing } = printCommentsSeparately(path, options);
      signatures.push([leading, doc]);
      body.unshift(trailing);
    }

    chainShouldBreak =
      chainShouldBreak ||
      // Always break the chain if:
      (node.returnType && getFunctionParameters(node).length > 0) ||
      node.typeParameters ||
      getFunctionParameters(node).some((param) => param.type !== "Identifier");

    if (node.body.type !== "ArrowFunctionExpression" || args?.expandLastArg) {
      body.unshift(print("body", args));
    } else {
      node = node.body;
      path.call(rec, "body");
    }
  })();

  if (signatures.length > 1) {
    return printArrowChain(
      path,
      args,
      signatures,
      chainShouldBreak,
      body,
      node
    );
  }

  const parts = signatures;
  parts.push(" =>");

  // We want to always keep these types of nodes on the same line
  // as the arrow.
  if (
    !hasLeadingOwnLineComment(options.originalText, node.body) &&
    (node.body.type === "ArrayExpression" ||
      node.body.type === "ObjectExpression" ||
      node.body.type === "BlockStatement" ||
      isJsxNode(node.body) ||
      (body[0].label?.hug !== false &&
        (body[0].label?.embed ||
          isTemplateOnItsOwnLine(node.body, options.originalText))) ||
      node.body.type === "ArrowFunctionExpression" ||
      node.body.type === "DoExpression")
  ) {
    return group([...parts, " ", body]);
  }

  // We handle sequence expressions as the body of arrows specially,
  // so that the required parentheses end up on their own lines.
  if (node.body.type === "SequenceExpression") {
    return group([
      ...parts,
      group([" (", indent([softline, body]), softline, ")"]),
    ]);
  }

  // if the arrow function is expanded as last argument, we are adding a
  // level of indentation and need to add a softline to align the closing )
  // with the opening (, or if it's inside a JSXExpression (e.g. an attribute)
  // we should align the expression's closing } with the line with the opening {.
  const shouldAddSoftLine =
    (args?.expandLastArg || path.parent.type === "JSXExpressionContainer") &&
    !hasComment(node);

  const printTrailingComma =
    args?.expandLastArg && shouldPrintComma(options, "all");

  // In order to avoid confusion between
  // a => a ? a : a
  // a <= a ? a : a
  const shouldAddParens =
    node.body.type === "ConditionalExpression" &&
    !startsWithNoLookaheadToken(node.body, /* forbidFunctionAndClass */ false);

  return group([
    ...parts,
    group([
      indent([
        line,
        shouldAddParens ? ifBreak("", "(") : "",
        body,
        shouldAddParens ? ifBreak("", ")") : "",
      ]),
      shouldAddSoftLine
        ? [ifBreak(printTrailingComma ? "," : ""), softline]
        : "",
    ]),
  ]);
}

function canPrintParamsWithoutParens(node) {
  const parameters = getFunctionParameters(node);
  return (
    parameters.length === 1 &&
    !node.typeParameters &&
    !hasComment(node, CommentCheckFlags.Dangling) &&
    parameters[0].type === "Identifier" &&
    !parameters[0].typeAnnotation &&
    !hasComment(parameters[0]) &&
    !parameters[0].optional &&
    !node.predicate &&
    !node.returnType
  );
}

function shouldPrintParamsWithoutParens(path, options) {
  if (options.arrowParens === "always") {
    return false;
  }

  if (options.arrowParens === "avoid") {
    const { node } = path;
    return canPrintParamsWithoutParens(node);
  }

  // Fallback default; should be unreachable
  /* c8 ignore next */
  return false;
}

/** @returns {Doc} */
function printReturnType(path, print) {
  const { node } = path;
  const returnType = print("returnType");

  const parts = [returnType];

  // prepend colon to TypeScript type annotation
  if (node.returnType && node.returnType.typeAnnotation) {
    parts.unshift(": ");
  }

  if (node.predicate) {
    // The return type will already add the colon, but otherwise we
    // need to do it ourselves
    parts.push(node.returnType ? " " : ": ", print("predicate"));
  }

  return parts;
}

// `ReturnStatement` and `ThrowStatement`
function printReturnOrThrowArgument(path, options, print) {
  const { node } = path;
  const semi = options.semi ? ";" : "";
  const parts = [];

  if (node.argument) {
    if (returnArgumentHasLeadingComment(options, node.argument)) {
      parts.push([" (", indent([hardline, print("argument")]), hardline, ")"]);
    } else if (
      isBinaryish(node.argument) ||
      node.argument.type === "SequenceExpression"
    ) {
      parts.push(
        group([
          ifBreak(" (", " "),
          indent([softline, print("argument")]),
          softline,
          ifBreak(")"),
        ])
      );
    } else {
      parts.push(" ", print("argument"));
    }
  }

  const comments = getComments(node);
  const lastComment = comments.at(-1);
  const isLastCommentLine = lastComment && isLineComment(lastComment);

  if (isLastCommentLine) {
    parts.push(semi);
  }

  if (hasComment(node, CommentCheckFlags.Dangling)) {
    parts.push(
      " ",
      printDanglingComments(path, options, /* sameIndent */ true)
    );
  }

  if (!isLastCommentLine) {
    parts.push(semi);
  }

  return parts;
}

function printReturnStatement(path, options, print) {
  return ["return", printReturnOrThrowArgument(path, options, print)];
}

function printThrowStatement(path, options, print) {
  return ["throw", printReturnOrThrowArgument(path, options, print)];
}

// This recurses the return argument, looking for the first token
// (the leftmost leaf node) and, if it (or its parents) has any
// leadingComments, returns true (so it can be wrapped in parens).
function returnArgumentHasLeadingComment(options, argument) {
  if (hasLeadingOwnLineComment(options.originalText, argument)) {
    return true;
  }

  if (hasNakedLeftSide(argument)) {
    let leftMost = argument;
    let newLeftMost;
    while ((newLeftMost = getLeftSide(leftMost))) {
      leftMost = newLeftMost;

      if (hasLeadingOwnLineComment(options.originalText, leftMost)) {
        return true;
      }
    }
  }

  return false;
}

export {
  printFunction,
  printArrowFunction,
  printMethod,
  printReturnStatement,
  printThrowStatement,
  printMethodInternal,
  shouldPrintParamsWithoutParens,
};
