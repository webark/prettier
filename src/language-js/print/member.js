import { softline, group, indent, label } from "../../document/builders.js";
import {
  isNumericLiteral,
  isMemberExpression,
  isCallExpression,
} from "../utils/index.js";
import { printOptionalToken } from "./misc.js";

function printMemberExpression(path, options, print) {
  const { node } = path;

  const { parent } = path;
  let firstNonMemberParent;
  let i = 0;
  do {
    firstNonMemberParent = path.getParentNode(i);
    i++;
  } while (
    firstNonMemberParent &&
    (isMemberExpression(firstNonMemberParent) ||
      firstNonMemberParent.type === "TSNonNullExpression")
  );

  const objectDoc = print("object");
  const lookupDoc = printMemberLookup(path, options, print);

  const shouldInline =
    (firstNonMemberParent &&
      (firstNonMemberParent.type === "NewExpression" ||
        firstNonMemberParent.type === "BindExpression" ||
        (firstNonMemberParent.type === "AssignmentExpression" &&
          firstNonMemberParent.left.type !== "Identifier"))) ||
    node.computed ||
    (node.object.type === "Identifier" &&
      node.property.type === "Identifier" &&
      !isMemberExpression(parent)) ||
    ((parent.type === "AssignmentExpression" ||
      parent.type === "VariableDeclarator") &&
      ((isCallExpression(node.object) && node.object.arguments.length > 0) ||
        (node.object.type === "TSNonNullExpression" &&
          isCallExpression(node.object.expression) &&
          node.object.expression.arguments.length > 0) ||
        objectDoc.label?.memberChain));

  return label(objectDoc.label, [
    objectDoc,
    shouldInline ? lookupDoc : group(indent([softline, lookupDoc])),
  ]);
}

function printMemberLookup(path, options, print) {
  const property = print("property");
  const { node } = path;
  const optional = printOptionalToken(path);

  if (!node.computed) {
    return [optional, ".", property];
  }

  if (!node.property || isNumericLiteral(node.property)) {
    return [optional, "[", property, "]"];
  }

  return group([optional, "[", indent([softline, property]), softline, "]"]);
}

export { printMemberExpression, printMemberLookup };
