import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  annotateOriginalHtml, generatePublicViews, renderTeachingAnnotation, teachingNotes,
} from "./generate-public-views.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("teaching annotation escapes all supplied copy and adds no executable markup", () => {
  const hostile = '<img src="https://invalid.example/" onerror="alert(1)"><script>alert(2)</script>&';
  const text = renderTeachingAnnotation(Object.fromEntries(
    ["question", "evidence", "answer", "limitation", "nextCheck"].map((key) => [key, hostile])));
  const document = new JSDOM(text).window.document;
  assert.equal(document.querySelectorAll("img,script,iframe,style").length, 0);
  assert.ok(document.body.textContent.includes(hostile));
  for (const element of document.querySelectorAll("*")) {
    assert.equal([...element.attributes].some((attribute) => /^on/i.test(attribute.name)), false);
  }
  assert.throws(() => annotateOriginalHtml("unrecognized", teachingNotes["sponsored-fee"]), /Unexpected/);
});

test("public views label synthetic data without JS and preserve original replay bundles byte for byte", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "z7on public teaching views "));
  try {
    const sourceRoot = path.join(temporary, "source");
    const child = spawnSync(process.execPath, [path.join(root, "examples/generate-reports.mjs"),
      "--out-root", sourceRoot], { cwd: root, encoding: "utf8", timeout: 120_000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const outputRoot = path.join(temporary, "public");
    await generatePublicViews({ sourceRoot, outputRoot });
    for (const slug of Object.keys(teachingNotes)) {
      const source = path.join(sourceRoot, slug, "report");
      const published = path.join(outputRoot, slug);
      for (const name of ["input.json", "report.json", "report.html", "manifest.json"]) {
        assert.equal(sha256(await readFile(path.join(source, name))),
          sha256(await readFile(path.join(published, "original", name))));
      }
      const replay = path.join(temporary, `replay-${slug}`);
      const reproduce = spawnSync(process.execPath, [path.join(root, "dist/src/inspector/node/cli.js"),
        "--input", path.join(published, "original/manifest.json"),
        "--wallet", "11111111111111111111111111111112", "--out", replay],
      { cwd: root, encoding: "utf8", timeout: 45_000, windowsHide: true });
      assert.equal(reproduce.status, 0, reproduce.stderr || reproduce.error?.message);
      for (const name of ["report.json", "report.html"]) {
        assert.deepEqual(await readFile(path.join(replay, name)), await readFile(path.join(source, name)));
      }
      assert.deepEqual(await readFile(path.join(published, "report.json")),
        await readFile(path.join(source, "report.json")));
      const originalHtml = await readFile(path.join(source, "report.html"), "utf8");
      const html = await readFile(path.join(published, "report.html"), "utf8");
      const originalDocument = new JSDOM(originalHtml).window.document;
      const document = new JSDOM(html).window.document; // Scripts deliberately disabled.
      assert.match(document.querySelector("#synthetic-teaching-title").textContent,
        /^SYNTHETIC TEACHING EXAMPLE — not blockchain data\.$/);
      assert.equal(document.querySelector("main").firstElementChild.id, "synthetic-teaching-notes");
      assert.equal(document.querySelector("#synthetic-teaching-notes").closest("[hidden],details"), null);
      assert.match(document.querySelector("#synthetic-teaching-notes").textContent, /Do not use this annotated HTML as a replay bundle/);
      for (const heading of ["Question", "Evidence", "Answer", "Limitation", "Next check"]) {
        assert.ok([...document.querySelectorAll("#synthetic-teaching-notes h3")].some((node) => node.textContent === heading));
      }
      const csp = (doc) => doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
      assert.equal(csp(document), csp(originalDocument));
      assert.match(csp(document), /connect-src 'none'/);
      assert.deepEqual([...document.querySelectorAll("script")].map((node) => node.textContent),
        [...originalDocument.querySelectorAll("script")].map((node) => node.textContent));
      assert.deepEqual([...document.querySelectorAll("style")].map((node) => node.textContent),
        [...originalDocument.querySelectorAll("style")].map((node) => node.textContent));
      for (const node of document.querySelectorAll("[src],[href]")) {
        assert.doesNotMatch(node.getAttribute("src") ?? node.getAttribute("href"), /^(?:https?:)?\/\//);
      }
      const activeScript = document.querySelector('script:not([type="application/json"])');
      const digest = createHash("sha256").update(activeScript.textContent).digest("base64");
      assert.ok(csp(document).includes(`'sha256-${digest}'`));
      for (const name of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md", "docs/protocol-provenance.md"]) {
        assert.deepEqual(await readFile(path.join(published, name)), await readFile(path.join(root, name)));
      }
      assert.equal(html.replace(renderTeachingAnnotation(teachingNotes[slug]), ""), originalHtml);
    }
    await assert.rejects(generatePublicViews({ sourceRoot, outputRoot }), /EEXIST/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
