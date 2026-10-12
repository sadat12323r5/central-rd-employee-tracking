import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every colour in the stylesheet must come from a named variable in :root, so contrast is only
// ever checked (and changed) in one place. The Staff portal's .staff-* rules are exempt until
// Story 6.3 tokenises them; that story extends this guard to the whole file.

type Rule = { selector: string; body: string };

/** Splits a stylesheet into `selector{body}` rules, descending into at-rule blocks such as @media. */
function parseRules(css: string): Rule[] {
  const source = css.replace(/^﻿/, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let i = 0;
  function walk(end: number) {
    let start = i;
    while (i < end) {
      const ch = source[i];
      if (ch === "{") {
        const prelude = source.slice(start, i).trim();
        let depth = 1;
        let j = i + 1;
        while (j < source.length && depth > 0) {
          if (source[j] === "{") depth++;
          else if (source[j] === "}") depth--;
          j++;
        }
        const close = j - 1;
        if (prelude.startsWith("@")) {
          i++;
          walk(close);
        } else {
          rules.push({ selector: prelude, body: source.slice(i + 1, close) });
        }
        i = close + 1;
        start = i;
      } else {
        i++;
      }
    }
  }
  walk(source.length);
  return rules;
}

// CSS named colours (CSS Color Module Level 4), excluding the allowed keywords transparent and currentColor.
const NAMED_COLOURS = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" ");
const NAMED = new RegExp(`(?<![\\w-])(?:${NAMED_COLOURS.join("|")})(?![\\w-])`, "i");
const FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX = /#[0-9a-f]{3,8}(?![\w-])/i;

/** The literal colours in a declaration block: values only, custom-property references excluded. */
function literalColours(body: string): string[] {
  return body
    .split(";")
    .map(declaration => declaration.slice(declaration.indexOf(":") + 1).replace(/var\([^)]*\)/g, ""))
    .filter(value => HEX.test(value) || FUNCTION.test(value) || NAMED.test(value))
    .map(value => value.trim());
}

const isExempt = (selector: string) =>
  selector === ":root" || selector.split(",").every(part => part.trim().startsWith(".staff-"));

describe("stylesheet colour tokens", () => {
  it("the guard finds literal colours, including inside @media and in named colours", () => {
    const rules = parseRules(".a{color:var(--ink)}@media(max-width:600px){.b{background:white;white-space:nowrap}}.c{border:1px solid #abc}.d{box-shadow:0 0 0 1px rgba(0,0,0,.1)}.staff-x{color:#fff}");
    const offenders = rules.filter(r => !isExempt(r.selector) && literalColours(r.body).length).map(r => r.selector);
    expect(offenders).toEqual([".b", ".c", ".d"]);
    expect(literalColours("white-space:nowrap;color:transparent;border-color:currentColor;color:inherit")).toEqual([]);
  });

  it("uses only :root variables outside :root and the .staff-* rules", () => {
    const css = readFileSync(join(process.cwd(), "src/app/styles.css"), "utf8");
    const rules = parseRules(css);
    expect(rules.length).toBeGreaterThan(100);
    const offenders = rules
      .filter(rule => !isExempt(rule.selector))
      .flatMap(rule => literalColours(rule.body).map(value => `${rule.selector} { ${value} }`));
    expect(offenders, `literal colours outside :root:\n${offenders.join("\n")}`).toEqual([]);
  });
});
