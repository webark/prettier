import { VISITOR_KEYS as babelVisitorKeys } from "@babel/types";
import { visitorKeys as tsVisitorKeys } from "@typescript-eslint/visitor-keys";
import flowVisitorKeys from "hermes-eslint/dist/HermesESLintVisitorKeys.js";
import unionVisitorKeys from "./union-visitor-keys.js";

const angularVisitorKeys = {
  NGRoot: ["node"],
  NGPipeExpression: ["left", "right", "arguments"],
  NGChainedExpression: ["expressions"],
  NGEmptyExpression: [],
  NGMicrosyntax: ["body"],
  NGMicrosyntaxKey: [],
  NGMicrosyntaxExpression: ["expression", "alias"],
  NGMicrosyntaxKeyedExpression: ["key", "expression"],
  NGMicrosyntaxLet: ["key", "value"],
  NGMicrosyntaxAs: ["key", "alias"],
};

const additionalVisitorKeys = {
  // Prettier
  JsExpressionRoot: ["node"],
  JsonRoot: ["node"],

  // Babel missing this
  Program: ["interpreter"],

  // Legacy node type
  SpreadProperty: ["argument"],

  // TypeScript
  TSJSDocAllType: [],
  TSJSDocUnknownType: [],
  TSJSDocNullableType: ["typeAnnotation"],
  TSJSDocNonNullableType: ["typeAnnotation"],
  // This one maybe invalid, need investigate
  TSAbstractMethodDefinition: ["decorators"],
  TSModuleDeclaration: ["modifiers"],
  TSEnumDeclaration: ["modifiers"],

  // Flow
  BigIntTypeAnnotation: [],
  QualifiedTypeofIdentifier: ["id", "qualification"],
  ClassProperty: ["variance"],
  ClassPrivateProperty: ["variance"],

  // Unknown
  Property: ["decorators"],
};

const excludeKeys = {
  // From `flowVisitorKeys`
  ArrowFunctionExpression: ["id"],
  DeclareOpaqueType: ["impltype"],
  FunctionExpression: ["predicate"],
};

const visitorKeys = Object.fromEntries(
  Object.entries(
    unionVisitorKeys([
      babelVisitorKeys,
      tsVisitorKeys,
      flowVisitorKeys,
      angularVisitorKeys,
      additionalVisitorKeys,
    ])
  ).map(([type, keys]) => [
    type,
    excludeKeys[type]
      ? keys.filter((key) => !excludeKeys[type].includes(key))
      : keys,
  ])
);

export default visitorKeys;
