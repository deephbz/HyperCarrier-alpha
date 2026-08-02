import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyRarebitComposition } from "../verify-rarebit-composition.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const json = file => JSON.parse(readFileSync(file, "utf8"));
function fixture() {
 const dir = mkdtempSync(path.join(os.tmpdir(), "rarebit-composition-"));
 git(root, "clone", "--no-hardlinks", ".", dir);
 const child = path.join(dir, "packages/hc-rarebit"); rmSync(child, { recursive:true, force:true });
 git(root, "clone", "--no-hardlinks", "packages/hc-rarebit", child);
 git(child, "remote", "set-url", "origin", "https://github.com/deephbz/rarebit.git");
 return { root:dir, child, cleanup:()=>rmSync(dir,{recursive:true,force:true}) };
}
function state(name, code, mutate) { test(name, () => { const f=fixture(); try { mutate(f); assert.throws(()=>verifyRarebitComposition({root:f.root}), e=>e.code===code || code==="invalid-record"); } finally { f.cleanup(); } }); }
test("valid disposable fixture verifies through the production verifier",()=>{const f=fixture();try{assert.equal(verifyRarebitComposition({root:f.root}).status,"verified")}finally{f.cleanup()}});
state("missing record","missing-record",({root})=>rmSync(path.join(root,"config/rarebit-compatibility.json")));
state("missing schema","missing-schema",({root})=>rmSync(path.join(root,"config/schemas/rarebit-compatibility.schema.json")));
state("missing child","missing-submodule",({root})=>rmSync(path.join(root,"packages/hc-rarebit"),{recursive:true}));
state("uninitialized child","uninitialized-submodule",({child})=>renameSync(path.join(child,".git"),path.join(child,".git.off")));
state("missing gitmodules","gitmodules",({root})=>rmSync(path.join(root,".gitmodules")));
state("wrong gitmodules URL","gitmodules",({root})=>writeFileSync(path.join(root,".gitmodules"),"[submodule \"packages/hc-rarebit\"]\n\tpath = packages/hc-rarebit\n\turl = https://bad.example/rarebit.git\n"));
state("wrong indexed gitlink","gitlink-mode",({root})=>git(root,"update-index","--cacheinfo",`100644,${git(root,"hash-object","package.json")},packages/hc-rarebit`));
state("wrong gitlink commit","gitlink-commit",({root})=>git(root,"update-index","--cacheinfo",`160000,${"1".repeat(40)},packages/hc-rarebit`));
state("wrong revision","revision",({child})=>{writeFileSync(path.join(child,"x"),"x");git(child,"add","x");git(child,"-c","user.email=x@y","-c","user.name=x","commit","-qm","x")});
state("wrong tree after exact revision", "tree", ({child})=>{const head=git(child,"rev-parse","HEAD");writeFileSync(path.join(child,"tree-drift"),"x");git(child,"add","tree-drift");git(child,"-c","user.email=x@y","-c","user.name=x","commit","-qm","tree drift");const replacement=git(child,"rev-parse","HEAD");git(child,"reset","--hard",head);git(child,"replace",head,replacement)});
state("wrong origin","origin",({child})=>git(child,"remote","set-url","origin","https://bad.example/r.git"));
state("dirty child","dirty-submodule",({child})=>writeFileSync(path.join(child,"dirty"),"x"));
function hiddenChild(file, edit){return ({child})=>{const p=path.join(child,file);const d=json(p);edit(d);writeFileSync(p,JSON.stringify(d));git(child,"update-index","--assume-unchanged",file)}}
state("child manifest name drift","package-name",hiddenChild("package.json",d=>d.name="bad"));
state("child manifest version drift","package-version",hiddenChild("package.json",d=>d.version="0"));
state("child manifest bin drift","package-bin",hiddenChild("package.json",d=>d.bin.rarebit="bad"));
state("child manifest node drift","package-node",hiddenChild("package.json",d=>d.engines.node="0"));
state("child manifest peer drift","peer-pi",hiddenChild("package.json",d=>d.peerDependencies["@earendil-works/pi-ai"]="0"));
state("child lock drift","child-lock-version",hiddenChild("package-lock.json",d=>d.version="0"));
state("root lock alias","root-lock-alias",({root})=>{const p=path.join(root,"package-lock.json");{const d=json(p);d.legacy="@hypercarrier/hc-rarebit";writeFileSync(p,JSON.stringify(d))}});
state("root lock link","root-lock-link",({root})=>{const p=path.join(root,"package-lock.json"),d=json(p);d.packages["node_modules/@hypercarrier/rarebit"].resolved="bad";writeFileSync(p,JSON.stringify(d))});
state("timeline manifest dependency","timeline-dependency",({root})=>{const p=path.join(root,"apps/timeline/package.json"),d=json(p);d.dependencies["@hypercarrier/rarebit"]="0";writeFileSync(p,JSON.stringify(d))});
state("exception missing","missing-exception",({root})=>rmSync(path.join(root,"config/rarebit-alpha.1-bootstrap-exception.json")));
state("exception digest","exception-digest",({root})=>writeFileSync(path.join(root,"config/rarebit-alpha.1-bootstrap-exception.json"),"{}"));
test("the exact alpha.4 dry-run and publish nonces are the only declared public nonces",()=>{const record=json(path.join(root,"config/rarebit-compatibility.json"));assert.deepEqual(new Set([record.verification.dryRun.nonce,record.verification.publish.nonce]),new Set(["b50a45f4-96ca-4d5a-8f51-5a95ea6d0ae8","36d95631-a45b-4769-9e15-18129ce54e52"]))});
for (const [name,keys,value] of [
 ["source commit",["source","commit"],"734aeb57d71c268fdabd723feefdd717785e9f9d"],
 ["source tree",["source","tree"],"1511e9f09ea7d1b68fb61613fc8620a94b3401c6"],
 ["tag object",["source","tagObject"],"4b06aacbfddaa1c8209fcd63731c9962bbf2536f"],
 ["package version",["package","version"],"0.1.0-alpha.2"],
 ["artifact SRI",["publication","sri"],"sha512-jZEIYB7xtY9YxaSI55bsLlMu1QiYDpknYKhBClYWJ6TQCIz0rLuB01qM/k3BpQAjOgdAtOQdjv/TEQeph+SXqA=="],
 ["dry-run nonce",["verification","dryRun","nonce"],["69b0e035","186a","4470","9324","a22f003f7710"].join("-")],
 ["publish nonce",["verification","publish","nonce"],["757148b5","fb6b","4e95","8313","62f98eb3ae42"].join("-")]
]) state(`real alpha.2 drift ${name}`,"invalid-record",({root})=>{const p=path.join(root,"config/rarebit-compatibility.json"),d=json(p);let o=d;for(const k of keys.slice(0,-1))o=o[k];o[keys.at(-1)]=value;writeFileSync(p,JSON.stringify(d))});
for (const keys of [["source","tree"],["source","tagObject"],["package","version"],["publication","sri"],["publication","signature","value"],["verification","ci","run"],["verification","dryRun","nonce"],["verification","publish","run"],["verification","publish","url"],["verification","publish","nonce"],["verification","publish","ref"],["verification","publish","head"],["verification","publish","attestation"],["verification","publish","attestationEndpoint"],["verification","publish","slsaPredicateType"],["verification","publish","workflow"],["verification","publish","workflowRef"],["verification","publish","resolvedCommit"],["verification","publish","invocation"]]) state(`immutable drift ${keys.join(".")}`,"invalid-record",({root})=>{const p=path.join(root,"config/rarebit-compatibility.json"),d=json(p);let o=d;for(const k of keys.slice(0,-1))o=o[k];o[keys.at(-1)]="wrong";writeFileSync(p,JSON.stringify(d))});
