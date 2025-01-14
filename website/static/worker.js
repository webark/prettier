/* globals prettier prettierPlugins parsersLocation */

"use strict";

const imported = Object.create(null);
function importScriptOnce(url) {
  if (!imported[url]) {
    imported[url] = true;
    importScripts(url);
  }
}

importScripts("lib/parsers-location.js");
importScripts("lib/standalone.js");

// this is required to only load parsers when we need them
const parsers = Object.create(null);
for (const [parser, file] of Object.entries(parsersLocation)) {
  Object.defineProperty(parsers, parser, {
    get() {
      const url = `lib/${file}`;
      importScriptOnce(url);
      return Object.values(prettierPlugins).find((plugin) =>
        Object.hasOwn(plugin.parsers, parser)
      ).parsers[parser];
    },
  });
}

const docExplorerPlugin = {
  parsers: {
    "doc-explorer": {
      parse: (text) =>
        new Function(
          `{ ${Object.keys(prettier.doc.builders)} }`,
          `const result = (${text || "''"}\n); return result;`
        )(prettier.doc.builders),
      astFormat: "doc-explorer",
    },
  },
  printers: {
    "doc-explorer": {
      print: (path) => path.getValue(),
    },
  },
  languages: [{ name: "doc-explorer", parsers: ["doc-explorer"] }],
};

self.onmessage = async function (event) {
  self.postMessage({
    uid: event.data.uid,
    message: await handleMessage(event.data.message),
  });
};

function serializeAst(ast) {
  return JSON.stringify(
    ast,
    (_, value) =>
      value instanceof Error
        ? { name: value.name, message: value.message, ...value }
        : typeof value === "bigint"
        ? `BigInt('${String(value)}')`
        : typeof value === "symbol"
        ? String(value)
        : value,
    2
  );
}

function handleMessage(message) {
  switch (message.type) {
    case "meta":
      return handleMetaMessage();
    case "format":
      return handleFormatMessage(message);
  }
}

async function handleMetaMessage() {
  const supportInfo = await prettier.getSupportInfo({
    plugins: [docExplorerPlugin],
  });

  return {
    type: "meta",
    supportInfo: JSON.parse(JSON.stringify(supportInfo)),
    version: prettier.version,
  };
}

async function handleFormatMessage(message) {
  const plugins = [{ parsers }, docExplorerPlugin];
  const options = { ...message.options, plugins };

  delete options.ast;
  delete options.doc;
  delete options.output2;

  const formatResult = await formatCode(
    message.code,
    options,
    message.debug.rethrowEmbedErrors
  );

  const response = {
    formatted: formatResult.formatted,
    cursorOffset: formatResult.cursorOffset,
    error: formatResult.error,
    debug: {
      ast: null,
      doc: null,
      comments: null,
      reformatted: null,
    },
  };

  for (const key of ["ast", "preprocessedAst"]) {
    if (!message.debug[key]) {
      continue;
    }
    let ast;
    let errored = false;
    try {
      const parsed = await prettier.__debug.parse(message.code, options, {
        preprocessForPrint: key === "preprocessedAst",
      });
      ast = serializeAst(parsed.ast);
    } catch (e) {
      errored = true;
      ast = String(e);
    }

    if (!errored) {
      try {
        ast = (await formatCode(ast, { parser: "json", plugins })).formatted;
      } catch {
        ast = serializeAst(ast);
      }
    }
    response.debug[key] = ast;
  }

  if (message.debug.doc) {
    try {
      response.debug.doc = await prettier.__debug.formatDoc(
        await prettier.__debug.printToDoc(message.code, options),
        { plugins }
      );
    } catch {
      response.debug.doc = "";
    }
  }

  if (message.debug.comments) {
    response.debug.comments = (
      await formatCode(JSON.stringify(formatResult.comments || []), {
        parser: "json",
        plugins,
      })
    ).formatted;
  }

  if (message.debug.reformat) {
    response.debug.reformatted = (
      await formatCode(response.formatted, options)
    ).formatted;
  }

  return response;
}

async function formatCode(text, options, rethrowEmbedErrors) {
  try {
    self.PRETTIER_DEBUG = rethrowEmbedErrors;
    return await prettier.formatWithCursor(text, options);
  } catch (e) {
    if (e.constructor && e.constructor.name === "SyntaxError") {
      // Likely something wrong with the user's code
      return { formatted: String(e), error: true };
    }
    // Likely a bug in Prettier
    // Provide the whole stack for debugging
    return { formatted: stringifyError(e), error: true };
  } finally {
    self.PRETTIER_DEBUG = undefined;
  }
}

function stringifyError(e) {
  const stringified = String(e);
  if (typeof e.stack !== "string") {
    return stringified;
  }
  if (e.stack.includes(stringified)) {
    // Chrome
    return e.stack;
  }
  // Firefox
  return stringified + "\n" + e.stack;
}
