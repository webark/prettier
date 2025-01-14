function preprocess(ast, options) {
  switch (options.parser) {
    case "json":
    case "json5":
    case "json-stringify":
    case "__js_expression":
    case "__vue_expression":
    case "__vue_ts_expression":
      return {
        ...ast,
        type: options.parser.startsWith("__") ? "JsExpressionRoot" : "JsonRoot",
        node: ast,
        comments: [],
        rootMarker: options.rootMarker,
      };
    default:
      return ast;
  }
}

export default preprocess;
