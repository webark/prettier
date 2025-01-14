import { group } from "../document/builders.js";

/**
 *     v-for="... in ..."
 *     v-for="... of ..."
 *     v-for="(..., ...) in ..."
 *     v-for="(..., ...) of ..."
 */
async function printVueFor(value, attributeTextToDoc) {
  const { left, operator, right } = parseVueFor(value);
  return [
    group(
      await attributeTextToDoc(`function _(${left}) {}`, {
        parser: "babel",
        __isVueForBindingLeft: true,
      })
    ),
    " ",
    operator,
    " ",
    await attributeTextToDoc(right, { parser: "__js_expression" }),
  ];
}

// modified from https://github.com/vuejs/vue/blob/v2.5.17/src/compiler/parser/index.js#L370-L387
function parseVueFor(value) {
  const forAliasRE = /(.*?)\s+(in|of)\s+(.*)/s;
  const forIteratorRE = /,([^,\]}]*)(?:,([^,\]}]*))?$/;
  const stripParensRE = /^\(|\)$/g;

  const inMatch = value.match(forAliasRE);
  if (!inMatch) {
    return;
  }

  const res = {};
  res.for = inMatch[3].trim();
  if (!res.for) {
    return;
  }

  const alias = inMatch[1].trim().replace(stripParensRE, "");
  const iteratorMatch = alias.match(forIteratorRE);
  if (iteratorMatch) {
    res.alias = alias.replace(forIteratorRE, "");
    res.iterator1 = iteratorMatch[1].trim();
    if (iteratorMatch[2]) {
      res.iterator2 = iteratorMatch[2].trim();
    }
  } else {
    res.alias = alias;
  }

  const left = [res.alias, res.iterator1, res.iterator2];
  if (
    left.some(
      (part, index) =>
        !part && (index === 0 || left.slice(index + 1).some(Boolean))
    )
  ) {
    return;
  }

  return {
    left: left.filter(Boolean).join(","),
    operator: inMatch[2],
    right: res.for,
  };
}

function printVueBindings(value, attributeTextToDoc) {
  return attributeTextToDoc(`function _(${value}) {}`, {
    parser: "babel",
    __isVueBindings: true,
  });
}

function isVueEventBindingExpression(eventBindingValue) {
  // https://github.com/vuejs/vue/blob/v2.5.17/src/compiler/codegen/events.js#L3-L4
  // arrow function or anonymous function
  const fnExpRE = /^(?:[\w$]+|\([^)]*\))\s*=>|^function\s*\(/;
  // simple member expression chain (a, a.b, a['b'], a["b"], a[0], a[b])
  const simplePathRE =
    /^[$A-Z_a-z][\w$]*(?:\.[$A-Z_a-z][\w$]*|\['[^']*']|\["[^"]*"]|\[\d+]|\[[$A-Z_a-z][\w$]*])*$/;

  // https://github.com/vuejs/vue/blob/v2.5.17/src/compiler/helpers.js#L104
  const value = eventBindingValue.trim();

  return fnExpRE.test(value) || simplePathRE.test(value);
}

export { isVueEventBindingExpression, printVueFor, printVueBindings };
