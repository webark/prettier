import createError from "../common/parser-create-error.js";
import parseFrontMatter from "../utils/front-matter/parse.js";
import { hasPragma } from "./pragma.js";
import { locStart, locEnd } from "./loc.js";
import { calculateLoc, replaceQuotesInInlineComments } from "./loc.js";
import hasSCSSInterpolation from "./utils/has-scss-interpolation.js";
import hasStringOrFunction from "./utils/has-string-or-function.js";
import isSCSSNestedPropertyNode from "./utils/is-scss-nested-property-node.js";
import isSCSSVariable from "./utils/is-scss-variable.js";
import stringifyNode from "./utils/stringify-node.js";
import isModuleRuleName from "./utils/is-module-rule-name.js";

const getHighestAncestor = (node) => {
  while (node.parent) {
    node = node.parent;
  }
  return node;
};

async function parseValueNode(valueNode, options) {
  const { nodes } = valueNode;
  let parenGroup = {
    open: null,
    close: null,
    groups: [],
    type: "paren_group",
  };
  const parenGroupStack = [parenGroup];
  const rootParenGroup = parenGroup;
  let commaGroup = {
    groups: [],
    type: "comma_group",
  };
  const commaGroupStack = [commaGroup];

  for (let i = 0; i < nodes.length; ++i) {
    const node = nodes[i];

    if (
      options.parser === "scss" &&
      node.type === "number" &&
      node.unit === ".." &&
      node.value.endsWith(".")
    ) {
      // Work around postcss bug parsing `50...` as `50.` with unit `..`
      // Set the unit to `...` to "accidentally" have arbitrary arguments work in the same way that cases where the node already had a unit work.
      // For example, 50px... is parsed as `50` with unit `px...` already by postcss-values-parser.
      node.value = node.value.slice(0, -1);
      node.unit = "...";
    }

    if (node.type === "func" && node.value === "selector") {
      node.group.groups = [
        await parseSelector(
          getHighestAncestor(valueNode).text.slice(
            node.group.open.sourceIndex + 1,
            node.group.close.sourceIndex
          )
        ),
      ];
    }

    if (node.type === "func" && node.value === "url") {
      const groups = (node.group && node.group.groups) || [];

      // Create a view with any top-level comma groups flattened.
      let groupList = [];
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (group.type === "comma_group") {
          groupList = [...groupList, ...group.groups];
        } else {
          groupList.push(group);
        }
      }

      // Stringify if the value parser can't handle the content.
      if (
        hasSCSSInterpolation(groupList) ||
        (!hasStringOrFunction(groupList) &&
          !isSCSSVariable(groupList[0], options))
      ) {
        const stringifiedContent = stringifyNode({
          groups: node.group.groups,
        });
        node.group.groups = [stringifiedContent.trim()];
      }
    }
    if (node.type === "paren" && node.value === "(") {
      parenGroup = {
        open: node,
        close: null,
        groups: [],
        type: "paren_group",
      };
      parenGroupStack.push(parenGroup);

      commaGroup = {
        groups: [],
        type: "comma_group",
      };
      commaGroupStack.push(commaGroup);
    } else if (node.type === "paren" && node.value === ")") {
      if (commaGroup.groups.length > 0) {
        parenGroup.groups.push(commaGroup);
      }
      parenGroup.close = node;

      /* c8 ignore next 3 */
      if (commaGroupStack.length === 1) {
        throw new Error("Unbalanced parenthesis");
      }

      commaGroupStack.pop();
      commaGroup = commaGroupStack.at(-1);
      commaGroup.groups.push(parenGroup);

      parenGroupStack.pop();
      parenGroup = parenGroupStack.at(-1);
    } else if (node.type === "comma") {
      parenGroup.groups.push(commaGroup);
      commaGroup = {
        groups: [],
        type: "comma_group",
      };
      commaGroupStack[commaGroupStack.length - 1] = commaGroup;
    } else {
      commaGroup.groups.push(node);
    }
  }
  if (commaGroup.groups.length > 0) {
    parenGroup.groups.push(commaGroup);
  }
  return rootParenGroup;
}

function flattenGroups(node) {
  if (
    node.type === "paren_group" &&
    !node.open &&
    !node.close &&
    node.groups.length === 1
  ) {
    return flattenGroups(node.groups[0]);
  }

  if (node.type === "comma_group" && node.groups.length === 1) {
    return flattenGroups(node.groups[0]);
  }

  if (node.type === "paren_group" || node.type === "comma_group") {
    return { ...node, groups: node.groups.map(flattenGroups) };
  }

  return node;
}

function addTypePrefix(node, prefix, skipPrefix) {
  if (node && typeof node === "object") {
    delete node.parent;
    for (const key in node) {
      addTypePrefix(node[key], prefix, skipPrefix);
      if (
        key === "type" &&
        typeof node[key] === "string" &&
        !node[key].startsWith(prefix) &&
        (!skipPrefix || !skipPrefix.test(node[key]))
      ) {
        node[key] = prefix + node[key];
      }
    }
  }
  return node;
}

function addMissingType(node) {
  if (node && typeof node === "object") {
    delete node.parent;
    for (const key in node) {
      addMissingType(node[key]);
    }
    if (!Array.isArray(node) && node.value && !node.type) {
      node.type = "unknown";
    }
  }
  return node;
}

async function parseNestedValue(node, options) {
  if (node && typeof node === "object") {
    for (const key in node) {
      if (key !== "parent") {
        await parseNestedValue(node[key], options);
        if (key === "nodes") {
          node.group = flattenGroups(await parseValueNode(node, options));
          delete node[key];
        }
      }
    }
    delete node.parent;
  }
  return node;
}

async function parseValue(value, options) {
  const Parser = await import("postcss-values-parser/lib/parser.js").then(
    (m) => m.default
  );
  const valueParser = (source, options) => new Parser(source, options);

  let result = null;

  try {
    result = valueParser(value, { loose: true }).parse();
  } catch {
    return {
      type: "value-unknown",
      value,
    };
  }

  result.text = value;

  const parsedResult = await parseNestedValue(result, options);

  return addTypePrefix(parsedResult, "value-", /^selector-/);
}

async function parseSelector(selector) {
  // If there's a comment inside of a selector, the parser tries to parse
  // the content of the comment as selectors which turns it into complete
  // garbage. Better to print the whole selector as-is and not try to parse
  // and reformat it.
  if (/\/\/|\/\*/.test(selector)) {
    return {
      type: "selector-unknown",
      value: selector.trim(),
    };
  }

  const SelectorProcessor = await import(
    "postcss-selector-parser/dist/processor.js"
  ).then((m) => m.default);
  const selectorParser = (processor) => new SelectorProcessor(processor);

  let result = null;

  try {
    selectorParser((result_) => {
      result = result_;
    }).process(selector);
  } catch {
    // Fail silently. It's better to print it as is than to try and parse it
    // Note: A common failure is for SCSS nested properties. `background:
    // none { color: red; }` is parsed as a NestedDeclaration by
    // postcss-scss, while `background: { color: red; }` is parsed as a Rule
    // with a selector ending with a colon. See:
    // https://github.com/postcss/postcss-scss/issues/39
    return {
      type: "selector-unknown",
      value: selector,
    };
  }

  return addTypePrefix(result, "selector-");
}

async function parseMediaQuery(params) {
  const mediaParser = await import("postcss-media-query-parser").then(
    (m) => m.default.default
  );

  let result = null;

  try {
    result = mediaParser(params);
  } catch {
    // Ignore bad media queries
    /* c8 ignore next 4 */
    return {
      type: "selector-unknown",
      value: params,
    };
  }

  return addTypePrefix(addMissingType(result), "media-");
}

const DEFAULT_SCSS_DIRECTIVE = /(\s*)(!default).*$/;
const GLOBAL_SCSS_DIRECTIVE = /(\s*)(!global).*$/;

async function parseNestedCSS(node, options) {
  if (node && typeof node === "object") {
    delete node.parent;

    for (const key in node) {
      await parseNestedCSS(node[key], options);
    }

    if (!node.type) {
      return node;
    }

    /* c8 ignore next */
    node.raws ??= {};

    // Custom properties looks like declarations
    if (
      node.type === "css-decl" &&
      typeof node.prop === "string" &&
      node.prop.startsWith("--") &&
      typeof node.value === "string" &&
      node.value.startsWith("{")
    ) {
      let rules;
      if (node.value.trimEnd().endsWith("}")) {
        const textBefore = options.originalText.slice(
          0,
          node.source.start.offset
        );
        const nodeText =
          "a".repeat(node.prop.length) +
          options.originalText.slice(
            node.source.start.offset + node.prop.length,
            node.source.end.offset + 1
          );
        const fakeContent = textBefore.replace(/[^\n]/g, " ") + nodeText;
        let parse;
        if (options.parser === "scss") {
          parse = parseScss;
        } else if (options.parser === "less") {
          parse = parseLess;
        } else {
          parse = parseCss;
        }
        let ast;
        try {
          ast = await parse(fakeContent, { ...options });
        } catch {
          // noop
        }
        if (
          ast &&
          ast.nodes &&
          ast.nodes.length === 1 &&
          ast.nodes[0].type === "css-rule"
        ) {
          rules = ast.nodes[0].nodes;
        }
      }
      if (rules) {
        node.value = {
          type: "css-rule",
          nodes: rules,
        };
      } else {
        node.value = {
          type: "value-unknown",
          value: node.raws.value.raw,
        };
      }
      return node;
    }

    let selector = "";

    if (typeof node.selector === "string") {
      selector = node.raws.selector
        ? node.raws.selector.scss ?? node.raws.selector.raw
        : node.selector;

      if (node.raws.between && node.raws.between.trim().length > 0) {
        selector += node.raws.between;
      }

      node.raws.selector = selector;
    }

    let value = "";

    if (typeof node.value === "string") {
      value = node.raws.value
        ? node.raws.value.scss ?? node.raws.value.raw
        : node.value;

      value = value.trim();

      node.raws.value = value;
    }

    let params = "";

    if (typeof node.params === "string") {
      params = node.raws.params
        ? node.raws.params.scss ?? node.raws.params.raw
        : node.params;

      if (node.raws.afterName && node.raws.afterName.trim().length > 0) {
        params = node.raws.afterName + params;
      }

      if (node.raws.between && node.raws.between.trim().length > 0) {
        params = params + node.raws.between;
      }

      params = params.trim();

      node.raws.params = params;
    }

    // Ignore LESS mixin declaration
    if (selector.trim().length > 0) {
      // TODO: confirm this code is dead
      /* c8 ignore next 3 */
      if (selector.startsWith("@") && selector.endsWith(":")) {
        return node;
      }

      // TODO: confirm this code is dead
      /* c8 ignore next 6 */
      // Ignore LESS mixins
      if (node.mixin) {
        node.selector = await parseValue(selector, options);

        return node;
      }

      // Check on SCSS nested property
      if (isSCSSNestedPropertyNode(node, options)) {
        node.isSCSSNesterProperty = true;
      }

      node.selector = await parseSelector(selector);

      return node;
    }

    if (value.length > 0) {
      const defaultSCSSDirectiveIndex = value.match(DEFAULT_SCSS_DIRECTIVE);

      if (defaultSCSSDirectiveIndex) {
        value = value.slice(0, defaultSCSSDirectiveIndex.index);
        node.scssDefault = true;

        if (defaultSCSSDirectiveIndex[0].trim() !== "!default") {
          node.raws.scssDefault = defaultSCSSDirectiveIndex[0];
        }
      }

      const globalSCSSDirectiveIndex = value.match(GLOBAL_SCSS_DIRECTIVE);

      if (globalSCSSDirectiveIndex) {
        value = value.slice(0, globalSCSSDirectiveIndex.index);
        node.scssGlobal = true;

        if (globalSCSSDirectiveIndex[0].trim() !== "!global") {
          node.raws.scssGlobal = globalSCSSDirectiveIndex[0];
        }
      }

      if (value.startsWith("progid:")) {
        return {
          type: "value-unknown",
          value,
        };
      }

      node.value = await parseValue(value, options);
    }

    if (
      options.parser === "less" &&
      node.type === "css-decl" &&
      value.startsWith("extend(")
    ) {
      // extend is missing
      node.extend ||= node.raws.between === ":";

      // `:extend()` is parsed as value
      if (node.extend && !node.selector) {
        delete node.value;
        node.selector = await parseSelector(value.slice("extend(".length, -1));
      }
    }

    if (node.type === "css-atrule") {
      if (options.parser === "less") {
        // mixin
        if (node.mixin) {
          const source =
            node.raws.identifier +
            node.name +
            node.raws.afterName +
            node.raws.params;
          node.selector = await parseSelector(source);
          delete node.params;
          return node;
        }

        // function
        if (node.function) {
          return node;
        }
      }

      // only css support custom-selector
      if (options.parser === "css" && node.name === "custom-selector") {
        const customSelector = node.params.match(/:--\S+\s+/)[0].trim();
        node.customSelector = customSelector;
        node.selector = await parseSelector(
          node.params.slice(customSelector.length).trim()
        );
        delete node.params;
        return node;
      }

      if (options.parser === "less") {
        // postcss-less doesn't recognize variables in some cases.
        // `@color: blue;` is recognized fine, but the cases below aren't:

        // `@color:blue;`
        if (node.name.includes(":") && !node.params) {
          node.variable = true;
          const parts = node.name.split(":");
          node.name = parts[0];
          node.value = await parseValue(parts.slice(1).join(":"), options);
        }

        // `@color :blue;`
        if (
          !["page", "nest", "keyframes"].includes(node.name) &&
          node.params &&
          node.params[0] === ":"
        ) {
          node.variable = true;
          node.value = await parseValue(node.params.slice(1), options);
          node.raws.afterName += ":";
        }

        // Less variable
        if (node.variable) {
          delete node.params;
          return node;
        }
      }
    }

    if (node.type === "css-atrule" && params.length > 0) {
      const { name } = node;
      const lowercasedName = node.name.toLowerCase();

      if (name === "warn" || name === "error") {
        node.params = {
          type: "media-unknown",
          value: params,
        };

        return node;
      }

      if (name === "extend" || name === "nest") {
        node.selector = await parseSelector(params);
        delete node.params;

        return node;
      }

      if (name === "at-root") {
        if (/^\(\s*(?:without|with)\s*:.+\)$/s.test(params)) {
          node.params = await parseValue(params, options);
        } else {
          node.selector = await parseSelector(params);
          delete node.params;
        }

        return node;
      }

      if (isModuleRuleName(lowercasedName)) {
        node.import = true;
        delete node.filename;
        node.params = await parseValue(params, options);
        return node;
      }

      if (
        [
          "namespace",
          "supports",
          "if",
          "else",
          "for",
          "each",
          "while",
          "debug",
          "mixin",
          "include",
          "function",
          "return",
          "define-mixin",
          "add-mixin",
        ].includes(name)
      ) {
        // Remove unnecessary spaces in SCSS variable arguments
        // Move spaces after the `...`, so we can keep the range correct
        params = params.replace(/(\$\S+?)(\s+)?\.{3}/, "$1...$2");
        // Remove unnecessary spaces before SCSS control, mixin and function directives
        // Move spaces after the `(`, so we can keep the range correct
        params = params.replace(/^(?!if)(\S+)(\s+)\(/, "$1($2");

        node.value = await parseValue(params, options);
        delete node.params;

        return node;
      }

      if (["media", "custom-media"].includes(lowercasedName)) {
        if (params.includes("#{")) {
          // Workaround for media at rule with scss interpolation
          return {
            type: "media-unknown",
            value: params,
          };
        }

        node.params = await parseMediaQuery(params);

        return node;
      }

      node.params = params;

      return node;
    }
  }

  return node;
}

async function parseWithParser(parse, text, options) {
  const parsed = parseFrontMatter(text);
  const { frontMatter } = parsed;
  text = parsed.content;

  let result;

  try {
    result = parse(text, {
      // Prevent file access https://github.com/postcss/postcss/blob/4f4e2932fc97e2c117e1a4b15f0272ed551ed59d/lib/previous-map.js#L18
      map: false,
    });
  } catch (error) {
    const { name, reason, line, column } = error;
    /* c8 ignore 3 */
    if (typeof line !== "number") {
      throw error;
    }

    throw createError(`${name}: ${reason}`, {
      loc: { start: { line, column } },
      cause: error,
    });
  }

  options.originalText = text;
  result = await parseNestedCSS(addTypePrefix(result, "css-"), options);

  calculateLoc(result, text);

  if (frontMatter) {
    frontMatter.source = {
      startOffset: 0,
      endOffset: frontMatter.raw.length,
    };
    result.frontMatter = frontMatter;
  }

  return result;
}

async function parseCss(text, options = {}) {
  const parse = await import("postcss/lib/parse").then((m) => m.default);
  return parseWithParser(parse, text, options);
}

async function parseLess(text, options = {}) {
  const less = await import("postcss-less");

  return parseWithParser(
    // Workaround for https://github.com/shellscape/postcss-less/issues/145
    // See comments for `replaceQuotesInInlineComments` in `loc.js`.
    (text) => less.parse(replaceQuotesInInlineComments(text)),
    text,
    options
  );
}

async function parseScss(text, options = {}) {
  const { default: parse } = await import("postcss-scss/lib/scss-parse");
  return parseWithParser(parse, text, options);
}

const postCssParser = {
  astFormat: "postcss",
  hasPragma,
  locStart,
  locEnd,
};

// Export as a plugin so we can reuse the same bundle for UMD loading
const postcssParser = {
  parsers: {
    css: {
      ...postCssParser,
      parse: parseCss,
    },
    less: {
      ...postCssParser,
      parse: parseLess,
    },
    scss: {
      ...postCssParser,
      parse: parseScss,
    },
  },
};

export default postcssParser;
