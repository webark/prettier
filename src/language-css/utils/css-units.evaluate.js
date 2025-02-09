import cssUnits from "css-units-list";

const CSS_UNITS = Object.fromEntries(
  cssUnits.map((unit) => [unit.toLowerCase(), unit])
);

export default CSS_UNITS;
