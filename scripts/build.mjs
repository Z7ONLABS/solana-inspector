import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = (file) => fs.readFileSync(path.join(root, file));
const meta = JSON.parse(bytes("package.json"));
const options = {
  target: ts.ScriptTarget.ES2022, newLine: ts.NewLineKind.LineFeed,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true, skipLibCheck: true, esModuleInterop: true, declaration: true,
  rootDir: root, outDir: path.join(root, "dist"), baseUrl: root,
  paths: { "@/*": ["./src/*"] }, types: ["node"], noEmitOnError: true,
};
const roots = ["src/analytics/solana/inspection.ts", "src/inspector/node/index.ts",
  "src/inspector/node/cli.ts", "src/inspector/node/worker.ts"];
const program = ts.createProgram(roots.map(f => path.join(root, f)), options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,
  {getCanonicalFileName:p=>p,getCurrentDirectory:()=>root,getNewLine:()=>"\n"}));
const graph = program.getSourceFiles().filter(f => !f.isDeclarationFile && !f.fileName.includes("node_modules"))
  .map(f => path.relative(root,f.fileName).replaceAll("\\","/")).sort();
if (graph.length !== 33 || graph.some(f => !f.startsWith("src/"))) throw new Error("Unreviewed source graph");
const rewrite = context => file => {
  const specifier = literal => {
    if (literal.text.startsWith("node:")) return literal;
    let target;
    if (literal.text === "decimal.js") target = path.join(root,"vendor/decimal.js");
    else {
      const resolved = ts.resolveModuleName(literal.text,file.fileName,options,ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || resolved.includes("node_modules")) throw new Error(`Unapproved runtime dependency: ${literal.text}`);
      target = resolved.replace(/\.tsx?$/, ".js");
    }
    let rel = path.relative(path.dirname(file.fileName),target).replaceAll("\\","/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return ts.factory.createStringLiteral(rel);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      return ts.factory.updateImportDeclaration(node,node.modifiers,node.importClause,specifier(node.moduleSpecifier),node.attributes);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      return ts.factory.updateExportDeclaration(node,node.modifiers,node.isTypeOnly,node.exportClause,specifier(node.moduleSpecifier),node.attributes);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
      return ts.factory.updateImportTypeNode(node,ts.factory.createLiteralTypeNode(specifier(node.argument.literal)),node.attributes,node.qualifier,node.typeArguments,node.isTypeOf);
    return ts.visitEachChild(node,visit,context);
  };
  return ts.visitNode(file,visit);
};
if (program.emit(undefined,undefined,undefined,false,{before:[rewrite],afterDeclarations:[rewrite]}).emitSkipped)
  throw new Error("Compilation did not emit");
const require = createRequire(import.meta.url);
const decimalRoot = path.dirname(require.resolve("decimal.js/package.json"));
fs.mkdirSync(path.join(root,"dist/vendor"),{recursive:true});
for (const [from,to] of [["decimal.mjs","decimal.js"],["decimal.d.ts","decimal.d.ts"]])
  fs.copyFileSync(path.join(decimalRoot,from),path.join(root,"dist/vendor",to));
const buildParent = path.join(root,".local/releases");
fs.mkdirSync(buildParent,{recursive:true});
const output = fs.mkdtempSync(path.join(buildParent,"package-"));
const normalized = file => Buffer.from(bytes(file).toString("utf8").replaceAll("\r\n","\n"));
const distFiles = [...graph.flatMap(f=>[f.replace(/^src\//,"dist/src/").replace(/\.ts$/,".js"),f.replace(/^src\//,"dist/src/").replace(/\.ts$/,".d.ts")]),"dist/vendor/decimal.js","dist/vendor/decimal.d.ts"];
const copied = [...graph,...distFiles,"README.md","LICENSE","NOTICE","THIRD-PARTY-NOTICES.md","docs/protocol-provenance.md"];
for (const file of copied) {
  const to = path.join(output,file);
  fs.mkdirSync(path.dirname(to),{recursive:true});
  fs.writeFileSync(to,normalized(file));
}
// Developer tooling stays in the source repository, never in runtime metadata.
const {devDependencies, scripts, packageManager, ...runtime} = meta;
fs.writeFileSync(path.join(output,"package.json"),JSON.stringify(runtime,null,2)+"\n");
const sourceFiles = [...graph,"package.json","scripts/build.mjs","pnpm-lock.yaml","README.md","LICENSE","NOTICE","THIRD-PARTY-NOTICES.md","docs/protocol-provenance.md"]
  .sort().map(file=>({file,sha256:sha(normalized(file))}));
const files = [...copied,"package.json"].sort().map(file=>({file,sha256:sha(fs.readFileSync(path.join(output,file)))}));
fs.writeFileSync(path.join(output,"BUILD-MANIFEST.json"),JSON.stringify({version:1,package:meta.name,packageVersion:meta.version,
  source:{schemaVersion:1,sha256:sha(JSON.stringify(sourceFiles)),files:sourceFiles},files,publicRelease:false},null,2)+"\n");
// npm pack is local and runs no lifecycle scripts. It does not publish to npm.
const npmCli = path.join(path.dirname(process.execPath),"node_modules/npm/bin/npm-cli.js");
const packArgs = ["pack","--json","--ignore-scripts","--offline"];
const packed = JSON.parse(execFileSync(process.platform === "win32" ? process.execPath : "npm",
  process.platform === "win32" ? [npmCli,...packArgs] : packArgs,{cwd:output,encoding:"utf8"}));
const tarball = path.join(output,packed[0].filename), checksum = sha(fs.readFileSync(tarball));
fs.writeFileSync(tarball+".sha256",`${checksum}  ${path.basename(tarball)}\n`);
const pointer = {version:meta.version,packageDirectory:output,tarball,sha256:checksum,files:files.length+1,
  sourceSha256:sha(JSON.stringify(sourceFiles)),node:process.version,platform:process.platform,arch:process.arch};
fs.writeFileSync(path.join(root,".local/latest-build.json"),JSON.stringify(pointer,null,2)+"\n");
console.log(JSON.stringify(pointer,null,2));
