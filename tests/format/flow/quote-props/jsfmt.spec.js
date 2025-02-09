run_spec(import.meta, ["flow", "babel-flow"], {
  quoteProps: "as-needed",
});

run_spec(import.meta, ["flow", "babel-flow"], {
  quoteProps: "preserve",
});

run_spec(import.meta, ["flow", "babel-flow"], {
  quoteProps: "consistent",
});

run_spec(import.meta, ["flow", "babel-flow"], {
  quoteProps: "consistent",
  singleQuote: true,
});
