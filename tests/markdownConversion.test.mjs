import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const built = esbuild.buildSync({
  entryPoints: [path.resolve("sync/markdownConversion.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false
});
const module = { exports: {} };
new Function("module", "exports", built.outputFiles[0].text)(module, module.exports);
const {
  obsidianToNotionMarkdown,
  notionToObsidianMarkdown,
  areObsidianAndNotionBodiesEquivalent,
  prepareNotionMarkdownForWrite,
  detectRemoteWriteBlocker
} = module.exports;

const callout = "> [!caution] Important\n> Keep this safe.";
const notionCallout = obsidianToNotionMarkdown(callout);
assert.equal(notionCallout.status, "success");
assert.match(notionCallout.markdown, /<callout icon="⚠️" color="yellow_bg">/);
assert.equal(notionToObsidianMarkdown(notionCallout.markdown).markdown, "> [!warning] Important\n> Keep this safe.");
assert.equal(areObsidianAndNotionBodiesEquivalent(callout, notionCallout.markdown), true);
assert.equal(areObsidianAndNotionBodiesEquivalent(callout, notionCallout.markdown.replace("safe", "changed")), false);
const adjacentCallouts = "> [!warning] First\n> first body\n> [!warning] Second\n> second body";
const adjacentCalloutsNotion = obsidianToNotionMarkdown(adjacentCallouts);
assert.equal(adjacentCalloutsNotion.status, "success");
assert.equal((adjacentCalloutsNotion.markdown.match(/<callout\b/g) ?? []).length, 2);
assert.equal(notionToObsidianMarkdown(adjacentCalloutsNotion.markdown).markdown, adjacentCallouts);
assert.equal(notionToObsidianMarkdown('<callout icon="🧪" color="purple_bg">\n\t**Custom title**\n\tbody\n</callout>').status, "unsafe");
assert.equal(notionToObsidianMarkdown("<callout>\n\tbody\n</callout>").status, "unsafe");
assert.equal(areObsidianAndNotionBodiesEquivalent(callout, '<callout icon="🧪" color="purple_bg">\n\tbody\n</callout>'), false);
assert.match(detectRemoteWriteBlocker('<details>unsafe</details>').construct, /unsupported/);
assert.match(detectRemoteWriteBlocker('# T {toggle="true" color="red"}').construct, /toggle/);
assert.match(detectRemoteWriteBlocker('# T {color="red" toggle="true"}').construct, /toggle/);

const nestedList = "- parent\n    - child\n        1. deep";
const nestedNotion = obsidianToNotionMarkdown(nestedList);
assert.equal(nestedNotion.markdown, "- parent\n\t- child\n\t\t1. deep");
assert.equal(notionToObsidianMarkdown(nestedNotion.markdown).markdown, nestedList);
assert.equal(obsidianToNotionMarkdown("Inline math: $x^2$").markdown, "Inline math: $x^2$");

const indentedCode = "\n    code\n    ==literal==";
assert.equal(obsidianToNotionMarkdown(indentedCode).markdown, indentedCode);
const indentedCodeList = "\n    code\n    - still code";
assert.equal(obsidianToNotionMarkdown(indentedCodeList).markdown, indentedCodeList);
assert.equal(obsidianToNotionMarkdown("- parent\n    - child").markdown, "- parent\n\t- child");
assert.equal(obsidianToNotionMarkdown("- parent\n    code-like text").markdown, "- parent\n    code-like text");
const literalIndentedCode = "\n    ![[image.png]]\n    <table>\n    ==highlight==\n    <u>underline</u>";
assert.equal(obsidianToNotionMarkdown(literalIndentedCode).markdown, literalIndentedCode);

const mathHighlight = obsidianToNotionMarkdown("Math $a==b$ end");
assert.equal(mathHighlight.status, "success");
assert.equal(mathHighlight.markdown.includes("<span"), false);
assert.equal(mathHighlight.markdown, "Math $a==b$ end");
const mathUnderline = obsidianToNotionMarkdown("Math $<u>x</u>$ end");
assert.equal(mathUnderline.markdown.includes('underline="true"'), false);
assert.equal(obsidianToNotionMarkdown("Math $a|b$ end").markdown.includes("<table"), false);
assert.equal(notionToObsidianMarkdown(mathHighlight.markdown).markdown, "Math $a==b$ end");
assert.equal(obsidianToNotionMarkdown("$$\na==b\n$$").markdown, "$$\na==b\n$$");
assert.equal(obsidianToNotionMarkdown("`$x$`").markdown, "`$x$`");
assert.equal(obsidianToNotionMarkdown("\\$x$ and price $5 and $10").markdown, "\\$x$ and price $5 and $10");
assert.equal(obsidianToNotionMarkdown("- parent\n  - child").status, "unsafe");
assert.equal(obsidianToNotionMarkdown("- parent\n   - child").status, "unsafe");

const escapedMath = "Math $a\\$b$ end";
assert.equal(obsidianToNotionMarkdown(escapedMath).markdown, escapedMath);
assert.equal(notionToObsidianMarkdown(obsidianToNotionMarkdown(escapedMath).markdown).markdown, escapedMath);
for (const slashes of [1, 2, 3]) {
  const source = `Math $a${"\\".repeat(slashes)}$b$ end`;
  const converted = obsidianToNotionMarkdown(source);
  assert.equal(converted.status, "success");
  assert.equal(converted.markdown, source);
  assert.equal(notionToObsidianMarkdown(converted.markdown).markdown, source);
}
assert.equal(obsidianToNotionMarkdown("Cost $5 + $10").markdown, "Cost $5 + $10");
assert.equal(obsidianToNotionMarkdown("Price $5 - $3").markdown, "Price $5 - $3");
assert.equal(obsidianToNotionMarkdown("Ratio $5 / $10").markdown, "Ratio $5 / $10");
assert.equal(obsidianToNotionMarkdown("Cost $5 + $10 and math $x$").markdown, "Cost $5 + $10 and math $x$");
assert.equal(obsidianToNotionMarkdown("Prices $5, $10; formula $x+y$").markdown, "Prices $5, $10; formula $x+y$");
const mixedCurrencyMath = obsidianToNotionMarkdown("Cost $5 + $10, then $x$ and $y$");
assert.equal(mixedCurrencyMath.markdown, "Cost $5 + $10, then $x$ and $y$");
assert.equal(obsidianToNotionMarkdown("Math $5 + 10$ end").markdown, "Math $5 + 10$ end");
assert.equal(obsidianToNotionMarkdown("Math $x + y$ end").markdown, "Math $x + y$ end");

for (const literal of [
  "```md\n<table>\n```",
  "```md\n<callout>\n```",
  "`<table>`",
  "\n    <table>",
  "$$\n<table>\n$$"
]) {
  const convertedLiteral = obsidianToNotionMarkdown(literal);
  assert.equal(convertedLiteral.status, "success");
  assert.equal(convertedLiteral.markdown, literal);
}
for (const literal of [
  "```md\n<table>\n```",
  "`<table>`",
  "$$\n<table>\n$$",
  "```md\n<callout>\n```",
  "`<callout>`",
  "$$\n<callout>\n$$"
]) {
  const convertedLiteral = notionToObsidianMarkdown(literal);
  assert.equal(convertedLiteral.status, "success");
  assert.equal(convertedLiteral.markdown, literal);
}
assert.equal(notionToObsidianMarkdown("<table>\n<tr><td>A</td></tr>").status, "unsafe");
assert.equal(notionToObsidianMarkdown("<callout icon=\"⚠️\" color=\"yellow_bg\">\n\topen").status, "unsafe");
for (let width = 1; width <= 8; width += 1) {
  const source = `- parent\n${" ".repeat(width)}- child`;
  const convertedList = obsidianToNotionMarkdown(source);
  if (width % 4 === 0) assert.equal(convertedList.markdown, `- parent\n${"\t".repeat(width / 4)}- child`);
  else assert.equal(convertedList.status, "unsafe");
}

const table = "| Name | Value |\n| --- | --- |\n| A | 10 |";
const notionTable = obsidianToNotionMarkdown(table);
assert.equal(notionTable.status, "success");
assert.match(notionTable.markdown, /<table header-row="true">/);
assert.equal(notionToObsidianMarkdown(notionTable.markdown).markdown, table);

const noHeader = obsidianToNotionMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
assert.equal(noHeader.status, "success");
assert.match(noHeader.markdown, /header-row="true"/);

const inline = obsidianToNotionMarkdown("==highlight== and <u>underlined</u> `==literal==`");
assert.equal(inline.status, "success");
assert.match(inline.markdown, /color="yellow_bg"/);
assert.match(inline.markdown, /underline="true"/);
assert.match(inline.markdown, /`==literal==`/);
assert.match(notionToObsidianMarkdown('<span color="red">red</span> <span color="green_bg"><u>both</u></span>').markdown, /red.*==<u>both<\/u>==/);

const protectedText = "---\ntitle: local\n---\n\n```md\n> [!warning]\n<table>\n==literal==\n```\n\n$$\n| math |\n$$";
assert.equal(obsidianToNotionMarkdown(protectedText).markdown, protectedText);
assert.equal(prepareNotionMarkdownForWrite("| Image |\n| --- |\n| ![[image.png]] |").status, "unsafe");
for (const unsupportedEmbed of ["![[image.png]]", "Math $x + ![[image.png]]$", "Cost $5 and ![[image.png]] + x$"]) {
  assert.equal(obsidianToNotionMarkdown(unsupportedEmbed).status, "unsafe");
}
for (const literalEmbed of ["```md\n![[image.png]]\n```", "`![[image.png]]`", "\n    ![[image.png]]", "$$\n![[image.png]]\n$$"]) {
  const convertedLiteral = obsidianToNotionMarkdown(literalEmbed);
  assert.equal(convertedLiteral.status, "success");
  assert.equal(convertedLiteral.markdown, literalEmbed);
}
assert.match(notionToObsidianMarkdown('Paragraph {color="blue_bg"}').markdown, /^Paragraph$/);

const notionFalseTable = '<table fit-page-width="true" header-row="false">\n<colgroup><col color="red" width="120" /></colgroup>\n<tr color="blue_bg"><td color="yellow_bg">A</td><td>B</td></tr>\n<tr><td>C</td><td>D</td></tr>\n</table>';
const falseTableObsidian = notionToObsidianMarkdown(notionFalseTable);
assert.equal(falseTableObsidian.status, "warning");
assert.match(falseTableObsidian.markdown, /llm-wiki-sync:table header-row=false/);
assert.match(falseTableObsidian.markdown, /\| A \| B \|\n\| --- \| --- \|\n\| C \| D \|/);
const falseTableBack = obsidianToNotionMarkdown(falseTableObsidian.markdown);
assert.equal(falseTableBack.status, "success");
assert.match(falseTableBack.markdown, /<table header-row="false">/);
assert.equal((falseTableBack.markdown.match(/<tr>/g) ?? []).length, 2);

const combined = "==<u>both</u>==";
const combinedNotion = obsidianToNotionMarkdown(combined);
assert.match(combinedNotion.markdown, /<span color="yellow_bg" underline="true">both<\/span>/);
assert.equal(notionToObsidianMarkdown(combinedNotion.markdown).markdown, combined);
assert.equal(notionToObsidianMarkdown('<span underline="true" color="yellow_bg">both</span>').markdown, combined);
assert.equal(notionToObsidianMarkdown('<span class="keep-me">hello</span>').markdown, '<span class="keep-me">hello</span>');
assert.equal(notionToObsidianMarkdown('<span color="yellow_bg" class="keep-me">hello</span>').markdown, '<span color="yellow_bg" class="keep-me">hello</span>');

assert.equal(areObsidianAndNotionBodiesEquivalent("a  b", "a b"), false);
assert.equal(areObsidianAndNotionBodiesEquivalent("```md\na  b\n```", "```md\na b\n```"), false);
assert.equal(notionToObsidianMarkdown('Heading {color="red"}').markdown, "Heading");
const toggle = notionToObsidianMarkdown('# Toggle {toggle="true" color="red"}');
assert.equal(toggle.markdown, '# Toggle {toggle="true" color="red"}');
assert.equal(toggle.status, "unsafe");
assert.equal(notionToObsidianMarkdown('The literal token {color="red"} should remain.').markdown, 'The literal token {color="red"} should remain.');

assert.equal(obsidianToNotionMarkdown("```js\n==literal==\n```").markdown, "```js\n==literal==\n```");
assert.equal(obsidianToNotionMarkdown("~~~~\n==literal==\n~~~~").status, "success");
assert.equal(obsidianToNotionMarkdown("````\n```\n````").status, "success");
assert.equal(obsidianToNotionMarkdown("```\nnot closed").status, "malformed");
assert.equal(obsidianToNotionMarkdown("~~~\nnot closed").status, "malformed");
assert.equal(obsidianToNotionMarkdown("$e^{2i\\pi} = 1$").markdown, "$e^{2i\\pi} = 1$");
assert.equal(notionToObsidianMarkdown("$`e^{2i\\pi} = 1`$").markdown, "$e^{2i\\pi} = 1$");
assert.equal(obsidianToNotionMarkdown("$$\ne^{2i\\pi} = 1\n$$").markdown, "$$\ne^{2i\\pi} = 1\n$$");

const wikilinkTable = "| Link |\n| --- |\n| [[note|alias]] |";
assert.equal(notionToObsidianMarkdown(obsidianToNotionMarkdown(wikilinkTable).markdown).markdown, wikilinkTable);
assert.equal(obsidianToNotionMarkdown("valid\n\n| A | B |\n| --- |\n| 1 | 2 |").status, "unsafe");
const unsupportedPolicy = notionToObsidianMarkdown('<columns><column>one</column></columns> <table_of_contents/> ![x](https://example.com/x.png)');
assert.equal(unsupportedPolicy.status, "unsafe");
assert.match(unsupportedPolicy.markdown, /<columns/);
assert.equal(notionToObsidianMarkdown('- parent\n\t![x](https://x/img.png)').status, 'unsafe');
assert.equal(notionToObsidianMarkdown('- parent\n\t<details><summary>X</summary>Y</details>').status, 'unsafe');
assert.equal(notionToObsidianMarkdown('- parent\n\t\t\t<page url="x">Child</page>').status, 'unsafe');
assert.equal(areObsidianAndNotionBodiesEquivalent('- parent\n    ![[image.png]]', '- parent\n\t![x](https://x/img.png)'), false);
assert.equal(obsidianToNotionMarkdown('- parent\n    ![[image.png]]').status, 'unsafe');
const indentedLiteral = '\n    ![[image.png]]';
assert.equal(obsidianToNotionMarkdown(indentedLiteral).markdown, indentedLiteral);
assert.equal(notionToObsidianMarkdown(obsidianToNotionMarkdown('Thing {color="red"}').markdown).markdown, 'Thing {color="red"}');

const protectedPayload = '![[image.png]]\n<table>\n<callout>\n==mark== <u>under</u> $x$ | {toggle="true"}\n\tpipe';
for (const wrap of [
  (body) => `\`\`\`md\n${body}\n\`\`\``,
  (body) => `\`${body.replace(/\n/g, " ")}\``,
  (body) => `\n${body.split("\n").map((line) => `    ${line}`).join("\n")}`,
  (body) => `$$\n${body}\n$$`,
  (body) => `---\n${body}\n---`
]) {
  const source = wrap(protectedPayload);
  const converted = obsidianToNotionMarkdown(source);
  assert.equal(converted.status, "success");
  assert.equal(converted.markdown, source);
}

for (const context of [
  (token) => token,
  (token) => `# Heading ${token}`,
  (token) => `- parent\n    - ${token}`,
  (token) => `1. parent\n    1. ${token}`,
  (token) => `- [ ] ${token}`,
  (token) => `> [!warning]\n> ${token}`,
  (token) => `Math $x + ${token}$`
]) {
  assert.equal(obsidianToNotionMarkdown(context('![[image.png]]')).status, "unsafe");
}

let fuzzState = 0x9e3779b9;
const fuzzTokens = ["plain", "==mark==", "<u>x</u>", "$x+y$", "|", "\\", "- item", "    - child", "`code`", "{color=\"red\"}", "![[image.png]]", "<details>x</details>"];
const nextFuzz = () => { fuzzState = (Math.imul(fuzzState, 1664525) + 1013904223) >>> 0; return fuzzState; };
for (let caseIndex = 0; caseIndex < 1000; caseIndex += 1) {
  const parts = Array.from({ length: 1 + (nextFuzz() % 6) }, () => fuzzTokens[nextFuzz() % fuzzTokens.length]);
  const source = parts.join(" ");
  let converted;
  assert.doesNotThrow(() => { converted = obsidianToNotionMarkdown(source); });
  assert.ok(["success", "warning", "unsafe", "malformed"].includes(converted.status));
  if (converted.status === "unsafe" || converted.status === "malformed") assert.equal(converted.markdown, source);
  if (source.includes("![[image.png]]") && !/^ {4}/.test(source) && converted.status !== "unsafe") throw new Error(`fuzz embed escaped detection: ${source}`);
}

const unsupportedNotionTokens = [
  '<page url="x">Child</page>',
  "<details>Y</details>",
  "<columns><column>x</column></columns>",
  "<database>x</database>",
  "<embed>x</embed>",
  "![a](https://x)",
  '<callout icon="🧪" color="purple_bg">\n\tbody\n</callout>',
  '{toggle="true"}'
];
const notionContexts = [
  (token) => token,
  (token) => `# Heading ${token}`,
  (token) => `- ${token}`,
  (token) => `- parent\n\t- ${token}`,
  (token) => `1. ${token}`,
  (token) => `- [ ] ${token}`,
  (token) => `<callout icon="⚠️" color="yellow_bg">\n\t${token}\n</callout>`,
  (token) => `Math $x + ${token}$`,
  (token) => `Cost $5 and ${token} + x$`
];
for (const token of unsupportedNotionTokens) {
  for (const context of notionContexts) {
    const source = context(token);
    const converted = notionToObsidianMarkdown(source);
    if (converted.status !== "unsafe") throw new Error(`Notion context escaped detection: ${source}`);
    assert.equal(converted.markdown, source);
  }
}
for (const literal of [
  "```md\n<page url=\"x\">Child</page>\n```",
  "`<details>Y</details>`",
  "$$\n![a](https://x)\n$$"
]) {
  const converted = notionToObsidianMarkdown(literal);
  assert.equal(converted.status, "success");
  assert.equal(converted.markdown, literal);
}
for (const remote of [
  'Math $x + <page url="x">Child</page>$',
  'Cost $5 and <details>Y</details> + x$',
  'Math $x + ![a](https://x)$'
]) assert.equal(areObsidianAndNotionBodiesEquivalent("plain", remote), false);

let inboundFuzzState = 0x7f4a7c15;
const inboundFuzzTokens = ["plain", "$x+y$", "- item", "\t- child", '<span color="yellow_bg">x</span>', "`code`", ...unsupportedNotionTokens];
const nextInboundFuzz = () => { inboundFuzzState = (Math.imul(inboundFuzzState, 1103515245) + 12345) >>> 0; return inboundFuzzState; };
for (let caseIndex = 0; caseIndex < 1000; caseIndex += 1) {
  const parts = Array.from({ length: 1 + (nextInboundFuzz() % 6) }, () => inboundFuzzTokens[nextInboundFuzz() % inboundFuzzTokens.length]);
  const source = parts.join(" ");
  let converted;
  assert.doesNotThrow(() => { converted = notionToObsidianMarkdown(source); });
  if (converted.status === "unsafe" || converted.status === "malformed") assert.equal(converted.markdown, source);
  if (unsupportedNotionTokens.some((token) => source.includes(token))) assert.equal(converted.status, "unsafe");
}

console.log("markdown conversion checks passed");
