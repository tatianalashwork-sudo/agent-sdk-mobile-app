import { readFile, writeFile } from "node:fs/promises";

const file = new URL("../dist/index.html", import.meta.url);
const html = await readFile(file, "utf8");
if (!html.includes("rel=\"manifest\"")) {
  const tags = [
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-title" content="Bloop" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    '<meta name="theme-color" content="#161618" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<link rel="apple-touch-icon" href="/bloop-icon.png" />',
  ].join("\n    ");
  await writeFile(file, html.replace("</head>", `    ${tags}\n  </head>`));
}
