import { indent, join, hardline } from "../../document/builders.js";
import {
  escapeTemplateCharacters,
  printTemplateExpressions,
} from "../print/template-literal.js";

async function embedGraphQL(textToDoc, print, path /*, options*/) {
  const { node } = path;

  const numQuasis = node.quasis.length;

  const expressionDocs = printTemplateExpressions(path, print);
  const parts = [];

  for (let i = 0; i < numQuasis; i++) {
    const templateElement = node.quasis[i];
    const isFirst = i === 0;
    const isLast = i === numQuasis - 1;
    const text = templateElement.value.cooked;

    const lines = text.split("\n");
    const numLines = lines.length;
    const expressionDoc = expressionDocs[i];

    const startsWithBlankLine =
      numLines > 2 && lines[0].trim() === "" && lines[1].trim() === "";
    const endsWithBlankLine =
      numLines > 2 &&
      lines[numLines - 1].trim() === "" &&
      lines[numLines - 2].trim() === "";

    const commentsAndWhitespaceOnly = lines.every((line) =>
      /^\s*(?:#[^\n\r]*)?$/.test(line)
    );

    // Bail out if an interpolation occurs within a comment.
    if (!isLast && /#[^\n\r]*$/.test(lines[numLines - 1])) {
      return null;
    }

    let doc = null;

    if (commentsAndWhitespaceOnly) {
      doc = printGraphqlComments(lines);
    } else {
      doc = await textToDoc(text, { parser: "graphql" });
    }

    if (doc) {
      doc = escapeTemplateCharacters(doc, false);
      if (!isFirst && startsWithBlankLine) {
        parts.push("");
      }
      parts.push(doc);
      if (!isLast && endsWithBlankLine) {
        parts.push("");
      }
    } else if (!isFirst && !isLast && startsWithBlankLine) {
      parts.push("");
    }

    if (expressionDoc) {
      parts.push(expressionDoc);
    }
  }

  return ["`", indent([hardline, join(hardline, parts)]), hardline, "`"];
}

function printGraphqlComments(lines) {
  const parts = [];
  let seenComment = false;

  const array = lines.map((textLine) => textLine.trim());
  for (const [i, textLine] of array.entries()) {
    // Lines are either whitespace only, or a comment (with potential whitespace
    // around it). Drop whitespace-only lines.
    if (textLine === "") {
      continue;
    }

    if (array[i - 1] === "" && seenComment) {
      // If a non-first comment is preceded by a blank (whitespace only) line,
      // add in a blank line.
      parts.push([hardline, textLine]);
    } else {
      parts.push(textLine);
    }

    seenComment = true;
  }

  // If `lines` was whitespace only, return `null`.
  return parts.length === 0 ? null : join(hardline, parts);
}

export default embedGraphQL;
