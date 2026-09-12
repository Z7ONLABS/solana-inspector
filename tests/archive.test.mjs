import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {gzipSync,gunzipSync} from "node:zlib";
import {fileURLToPath} from "node:url";
import {inspectArchive,verifyPackage} from "../scripts/check-package.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const candidate=JSON.parse(fs.readFileSync(path.join(root,".local/latest-build.json"),"utf8"));
const compressed=fs.readFileSync(candidate.tarball);
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");

test("actual tar inventory and source licence are complete",()=>{
  const result=verifyPackage(candidate.tarball,candidate.sha256);
  assert.equal(result.files,108);assert.equal(result.version,"0.4.0");
});
test("hash mismatch and truncated gzip fail before any extraction",()=>{
  assert.throws(()=>inspectArchive(compressed,"0".repeat(64)),/hash mismatch/);
  const bad=compressed.subarray(0,Math.floor(compressed.length/2));
  assert.throws(()=>inspectArchive(bad,sha(bad)));
});
test("path traversal, symlinks, unsafe modes and broken checksum are rejected",()=>{
  const mutate=fn=>{
    const tar=gunzipSync(compressed);fn(tar);
    const data=gzipSync(tar);return()=>inspectArchive(data,sha(data));
  };
  const checksum=tar=>{
    tar.fill(32,148,156);
    const sum=tar.subarray(0,512).reduce((total,b)=>total+b,0);
    tar.write(sum.toString(8).padStart(6,"0")+"\0 ",148,"ascii");
  };
  assert.throws(mutate(tar=>{tar.fill(0,0,100);tar.write("package/../escape",0,"ascii");checksum(tar);}),/unsafe path/);
  assert.throws(mutate(tar=>{tar[156]=50;checksum(tar);}),/nonregular member/);
  assert.throws(mutate(tar=>{tar.write("0000777\0",100,"ascii");checksum(tar);}),/unsafe mode/);
  assert.throws(mutate(tar=>{tar[0]^=1;}),/header checksum/);
});
