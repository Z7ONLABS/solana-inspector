import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const wallet = "11111111111111111111111111111112";
const guard = pathToFileURL(path.join(root,"tests/helpers/inspector-network-guard.mjs")).href;
const npmCli = path.join(path.dirname(process.execPath),"node_modules/npm/bin/npm-cli.js");
const npxCli = path.join(path.dirname(process.execPath),"node_modules/npm/bin/npx-cli.js");

test("standalone offline install, installed CLI, both SDKs, replay, hostile input and cancellation", {timeout:60_000}, async () => {
  const candidate = JSON.parse(await fs.readFile(path.join(root,".local/latest-build.json"),"utf8"));
  assert.equal(sha(await fs.readFile(candidate.tarball)),candidate.sha256);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"z7on-standalone "));
  assert.ok(directory.startsWith(path.join(os.tmpdir(),"z7on-standalone ")));
  try {
    const cache = path.join(directory,"empty npm cache");
    const config = path.join(directory,"empty npmrc");
    const globalConfig = path.join(directory,"empty global npmrc");
    await fs.mkdir(cache);
    await fs.writeFile(config,""); await fs.writeFile(globalConfig,"");
    await fs.writeFile(path.join(directory,"package.json"),JSON.stringify({private:true,type:"module"}));
    const env = {};
    for (const key of ["SystemRoot","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","PATH","PATHEXT","HOME","USERPROFILE"])
      if (process.env[key]) env[key] = process.env[key];
    Object.assign(env,{npm_config_cache:cache,npm_config_userconfig:config,npm_config_globalconfig:globalConfig,
      npm_config_offline:"true",npm_config_audit:"false",npm_config_fund:"false",npm_config_update_notifier:"false"});
    const run = (args, code=0, protectedRun=true) => {
      const result = spawnSync(process.execPath,args,{cwd:directory,encoding:"utf8",timeout:25_000,
        env:{...env,...(protectedRun?{NODE_OPTIONS:`--import=${guard}`}:{})}});
      assert.equal(result.status,code,`${args[0]}\n${result.stdout}\n${result.stderr}`);
      return result;
    };
    run([npmCli,"install",candidate.tarball,"--ignore-scripts","--offline","--no-audit","--no-fund"],0,false);
    assert.match(run([npxCli,"--no-install","z7on-inspect","--version"]).stdout,/0\.4\.0/);
    assert.match(run([npxCli,"--no-install","z7on-inspect","--help"]).stdout,/Analysis is offline/);
    // Explicitly fictional record; no chain calls or claims of authenticity.
    const raw = {slot:42,version:"legacy",blockTime:1700000000,
      transaction:{signatures:["synthetic-package-only"],message:{accountKeys:[{pubkey:wallet,signer:true,writable:true},{pubkey:"recipient",signer:false,writable:true}],
        instructions:[{program:"system",programId:"11111111111111111111111111111111",parsed:{type:"transfer",info:{source:wallet,destination:"recipient",lamports:100}}}]}},
      meta:{fee:5,err:null,preBalances:[1000,0],postBalances:[895,100],preTokenBalances:[],postTokenBalances:[],innerInstructions:[]}};
    await fs.writeFile(path.join(directory,"input.json"),JSON.stringify(raw));
    const inspectArgs = [npxCli,"--no-install","z7on-inspect","--input","input.json","--wallet",wallet,"--out","first report"];
    run(inspectArgs);
    run([npxCli,"--no-install","z7on-inspect","--input","first report/manifest.json","--wallet",wallet,"--out","replayed report"]);
    for (const file of ["input.json","report.json","report.html","manifest.json"])
      assert.deepEqual(await fs.readFile(path.join(directory,"first report",file)),await fs.readFile(path.join(directory,"replayed report",file)));
    const sdk = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {createHash} from 'node:crypto';
      import {inspectSolanaEvidence} from '@z7onlabs/solana-inspector';
      import {executeInspector} from '@z7onlabs/solana-inspector/node';
      const raw=fs.readFileSync('input.json'); const hash=createHash('sha256').update(raw).digest('hex');
      const r=inspectSolanaEvidence({walletAddress:'${wallet}',inputSha256:hash,transactions:[{raw:JSON.parse(raw),payloadSha256:hash}]});
      assert.equal(r.version,'solana-inspection-v2');assert.equal(r.summary.uniqueTransactions,1);assert.equal(r.financial.state,'unavailable');
      await executeInspector({input:'input.json',wallet:'${wallet}',out:'sdk report'});
      const controller=new AbortController();controller.abort();
      await assert.rejects(executeInspector({input:'input.json',wallet:'${wallet}',out:'cancelled',signal:controller.signal}),e=>e.exitCode===130);`;
    // A real file avoids inheriting eval-only --input-type in Node worker threads.
    await fs.writeFile(path.join(directory,"sdk-check.mjs"),sdk);
    run(["sdk-check.mjs"]);
    assert.deepEqual(await fs.readFile(path.join(directory,"first report/report.json")),await fs.readFile(path.join(directory,"sdk report/report.json")));
    const duplicate = '{"a":1,"a":2}';
    await fs.writeFile(path.join(directory,"bad.json"),duplicate);
    run([npxCli,"--no-install","z7on-inspect","--input","bad.json","--wallet",wallet,"--out","bad output"],2);
    assert.equal(await fs.readFile(path.join(directory,"bad.json"),"utf8"),duplicate);
    await assert.rejects(fs.stat(path.join(directory,"bad output")));
    run(inspectArgs,3); // Existing output remains untouched.
    const probe=run(["--input-type=module","--eval","await fetch('http://127.0.0.1:1')"],91);
    assert.match(probe.stderr,/connection/i);
  } finally {
    // Only this newly-created test directory is removed, never user reports.
    await fs.rm(directory,{recursive:true,force:true});
  }
});
