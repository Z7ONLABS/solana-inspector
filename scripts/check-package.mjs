import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const decoder = new TextDecoder("utf8", {fatal:true});
const own = JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));

/** Read only: bounded USTAR regular members, no extraction or code execution. */
export function inspectArchive(compressed, expectedSha256) {
  assert.ok(compressed.length > 0 && compressed.length <= 8*1024*1024,"compressed byte limit");
  assert.match(expectedSha256,/^[a-f0-9]{64}$/);
  assert.equal(hash(compressed),expectedSha256,"tarball hash mismatch");
  const tar = gunzipSync(compressed,{maxOutputLength:32*1024*1024});
  assert.ok(tar.length >= 1024 && tar.length % 512 === 0,"invalid tar length");
  const files = new Map(), names = new Set();
  const string = (header,start,length) => {
    const bytes = header.subarray(start,start+length), zero = bytes.indexOf(0);
    if(zero >= 0) assert.ok(bytes.subarray(zero).every(b=>b===0),"invalid field padding");
    return decoder.decode(zero<0?bytes:bytes.subarray(0,zero));
  };
  const octal = (header,start,length) => {
    const text=header.subarray(start,start+length).toString("latin1");
    assert.match(text,/^[0-7]+[\0 ]*$/,"invalid octal");
    const value=parseInt(text,8); assert.ok(Number.isSafeInteger(value)); return value;
  };
  let offset=0, ended=false;
  while(offset+512 <= tar.length) {
    const h=tar.subarray(offset,offset+512);
    if(h.every(b=>b===0)) {
      assert.ok(tar.length-offset>=1024 && tar.subarray(offset).every(b=>b===0),"invalid terminator");
      ended=true;break;
    }
    assert.ok(files.size<256,"member limit");
    const sum=h.reduce((total,b,i)=>total+(i>=148&&i<156?32:b),0);
    assert.equal(octal(h,148,8),sum,"header checksum");
    assert.deepEqual(h.subarray(257,265),Buffer.from([117,115,116,97,114,0,48,48]),"unsupported format");
    assert.ok(h[156]===0||h[156]===48,"nonregular member");
    assert.equal(string(h,157,100),"","link forbidden");
    const prefix=string(h,345,155), file=`${prefix?prefix+"/":""}${string(h,0,100)}`;
    assert.match(file,/^package\/[A-Za-z0-9_./-]+$/,"unsafe path");
    assert.ok(file.length<=240 && file.split("/").every(p=>p&&p!=="."&&p!==".."&&!p.endsWith(".")&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)),"unsafe path");
    const name=file.slice(8);
    assert.ok(!names.has(name.toLowerCase()),"duplicate path");names.add(name.toLowerCase());
    const mode=octal(h,100,8); assert.equal(mode&0o7022,0,"unsafe mode");
    const size=octal(h,124,12);assert.ok(size<=8*1024*1024,"member byte limit");
    const start=offset+512,end=start+size,next=start+Math.ceil(size/512)*512;
    assert.ok(next<=tar.length,"truncated member");
    assert.ok(tar.subarray(end,next).every(b=>b===0),"invalid data padding");
    files.set(name,tar.subarray(start,end));offset=next;
  }
  assert.ok(ended,"missing tar terminator");
  return files;
}

function manifest(bytes) {
  assert.ok(bytes && bytes.length<128*1024,"manifest size/missing");
  const text=decoder.decode(bytes), data=JSON.parse(text);
  assert.equal(text,JSON.stringify(data,null,2)+"\n","noncanonical manifest");return data;
}

export function verifyPackage(tarball,expectedSha256) {
  const before=fs.lstatSync(tarball);
  assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.size<=8*1024*1024,"not a bounded regular archive");
  const compressed=fs.readFileSync(tarball),after=fs.lstatSync(tarball);
  assert.ok(!after.isSymbolicLink()&&after.isFile()&&before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,"archive changed during read");
  const files=inspectArchive(compressed,expectedSha256);
  const internal=Object.entries(own.exports).filter(([key])=>key.startsWith("./internal/"));
  assert.equal(internal.length,33,"unreviewed internal graph");
  const sources=internal.map(([,value])=>value.import.replace(/^\.\/dist\//,"").replace(/\.js$/,".ts"));
  const allowed=new Set(["package.json","README.md","LICENSE","NOTICE","THIRD-PARTY-NOTICES.md","BUILD-MANIFEST.json","docs/protocol-provenance.md",
    ...sources,...internal.flatMap(([,value])=>[value.import.slice(2),value.types.slice(2)]),"dist/vendor/decimal.js","dist/vendor/decimal.d.ts"]);
  assert.deepEqual([...files.keys()].sort(),[...allowed].sort(),"missing or unreviewed archive member");
  const pkg=manifest(files.get("package.json")), inventory=manifest(files.get("BUILD-MANIFEST.json"));
  assert.equal(pkg.name,own.name);assert.equal(pkg.version,"0.4.0");assert.equal(pkg.license,"Apache-2.0");
  assert.equal(pkg.private,true);assert.equal(pkg.type,"module");
  assert.deepEqual(pkg.exports,own.exports);assert.deepEqual(pkg.bin,own.bin);assert.deepEqual(pkg.engines,own.engines);
  for(const key of ["scripts","dependencies","optionalDependencies","peerDependencies","devDependencies"]) assert.ok(!Object.hasOwn(pkg,key),`runtime ${key} forbidden`);
  assert.equal(inventory.version,1);assert.equal(inventory.package,pkg.name);assert.equal(inventory.packageVersion,pkg.version);assert.equal(inventory.publicRelease,false);
  assert.deepEqual(Object.keys(inventory).sort(),["files","package","packageVersion","publicRelease","source","version"]);
  const listed=inventory.files;
  assert.deepEqual(listed.map(e=>e.file),listed.map(e=>e.file).sort());
  assert.deepEqual(listed.map(e=>e.file),[...files.keys()].filter(f=>f!=="BUILD-MANIFEST.json").sort());
  for(const entry of listed) {
    assert.deepEqual(Object.keys(entry).sort(),["file","sha256"]);
    assert.equal(hash(files.get(entry.file)),entry.sha256,`inventory mismatch: ${entry.file}`);
  }
  assert.equal(inventory.source.schemaVersion,1);
  assert.equal(hash(JSON.stringify(inventory.source.files)),inventory.source.sha256);
  assert.deepEqual(inventory.source.files.map(e=>e.file),inventory.source.files.map(e=>e.file).sort());
  for(const entry of inventory.source.files) {
    assert.match(entry.file,/^(?:src\/|scripts\/|docs\/|package\.json$|pnpm-lock\.yaml$|README\.md$|LICENSE$|NOTICE$|THIRD-PARTY-NOTICES\.md$)/);
    assert.ok(!entry.file.split("/").some(p=>p===".."));assert.match(entry.sha256,/^[a-f0-9]{64}$/);
    if(files.has(entry.file) && entry.file!=="package.json") assert.equal(hash(files.get(entry.file)),entry.sha256);
  }
  assert.match(decoder.decode(files.get("LICENSE")),/Apache License[\s\S]*Version 2\.0, January 2004[\s\S]*END OF TERMS AND CONDITIONS/);
  const notices=decoder.decode(files.get("THIRD-PARTY-NOTICES.md"));
  for(const required of ["decimal.js 10.6.0","Michael Mclaughlin","SevenLabs","MIT License"]) assert.ok(notices.includes(required));
  for(const [file,data] of files) {
    const text=decoder.decode(data);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:postgres|postgresql):\/\/[^\s]+@/.test(text),`secret marker: ${file}`);
    assert.ok(!/[A-Z]:[\\/]proyectos[\\/]|\.local-data[\\/]|api_key\s*[:=]\s*['"][A-Za-z0-9_-]{20}/i.test(text),`private reference: ${file}`);
  }
  return {version:pkg.version,sha256:expectedSha256,compressedBytes:compressed.length,files:files.size,sourceSha256:inventory.source.sha256};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const pointer=JSON.parse(fs.readFileSync(path.join(root,".local/latest-build.json"),"utf8"));
  console.log(JSON.stringify(verifyPackage(pointer.tarball,pointer.sha256),null,2));
}
