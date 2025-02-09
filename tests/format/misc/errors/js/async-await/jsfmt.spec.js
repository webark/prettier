import { outdent } from "outdent";

run_spec(
  {
    importMeta: import.meta,
    snippets: [
      outdent`
        async function foo() {
          function bar(x = await 2) {}
        }
      `,
      "async (x = await 2) => {};",
      "f = async (a) => await a! ** 6;",
      "f = (a) => +a! ** 6;",
      "async (a) => (await a!) ** 6;",
      "(-+5 ** 6);",
      "f = async () => await 5 ** 6;",
      "f = async () => await -5 ** 6;",
      "async({ foo33 = 1 });",
    ],
  },
  ["babel", "acorn", "espree", "meriyah", "flow"]
);

run_spec(
  {
    importMeta: import.meta,
    snippets: [
      // `flow` and `meriyah` didn't throw
      "async (x = await (2)) => {};",
    ],
  },
  ["babel", "acorn", "espree"]
);
