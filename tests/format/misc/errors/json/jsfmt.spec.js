run_spec(
  {
    importMeta: import.meta,
    snippets: [
      "{foo}",
      '{["foo"]:"bar"}',
      '{"foo": ~1}',
      '{"foo": false || "bar"}',
      '{"foo": () => {}}',
      "packages\\the-hub\\cypress\\fixtures\\gridConfiguration.json",
      "1+2",
      "{Infinity}",
      "{[key]: 1}",
      "{[key()]: 1}",
      "{['CallExpression']: 1}",
      "{['StringLiteral']: 1}",
      "{['string']: 1}",
      "{[1]: 1}",
      "{[Infinity]: 1}",
      "{[-Infinity]: 1}",
      "{[{key: 'value'}]: 1}",
      "{[[]]: 1}",
      "{[null]: 1}",
      "{key: +foo()}",
      "{key: void foo()}",
      "#!/usr/bin/env node\n{}",
      '"use strict"\n{}',
      "/* comment */",
      "// comment",
      "`foo${1}bar`",
      "-+1",
      "-+Infinity",
      "-undefined",
      "-null",
      "-false",
      "+'string'",
      "{key: +{}}",
      '{"identifier": identifier}',
      // JSON6 allow this, but babel can't parse
      "----123",
    ],
  },
  ["json", "json5", "json-stringify"]
);
