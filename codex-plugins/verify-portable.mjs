// Run the actual distributable through PATH from a relocated Unicode directory.
// This only discovers tools/resources; it never initializes a user library or model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./codex-design/', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex design 便携验证 '));
const relocated = path.join(directory, '插件 package');
await fs.cp(source, relocated, { recursive:true, errorOnExist:true });
const config = JSON.parse(await fs.readFile(path.join(relocated, 'mcp.json'), 'utf8'));
const manifest = JSON.parse(await fs.readFile(path.join(relocated, 'plugin.json'), 'utf8'));
const server = config.mcpServers['codex-design'];
assert.equal(server.command, 'node');
const expand = value => value.replaceAll('${PLUGIN_ROOT}', relocated);
const child = spawn(server.command, server.args.map(expand), {
  cwd: expand(server.cwd), env: {...process.env, NODE_PATH:''}, windowsHide:true, shell:false, stdio:['pipe','pipe','pipe'],
});
const pending = new Map();let id=0, stderr='';
const lines = createInterface({input:child.stdout});
child.stderr.on('data',value=>{stderr=(stderr+value).slice(-3000);});
lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const call=pending.get(value.id);if(!call)return;pending.delete(value.id);clearTimeout(call.timer);value.error?call.reject(new Error(JSON.stringify(value.error))):call.resolve(value.result);});
child.once('error',error=>{for(const call of pending.values())call.reject(error);});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error(method+': '+stderr));},15000);pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
try {
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'codex-design-portable-verifier',version:manifest.version}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await rpc('tools/list',{});const resources=await rpc('resources/list',{});
  const entry=tools.tools.find(tool=>tool.name==='DesignLibrary');
  assert.ok(entry);
  assert.equal(entry._meta.ui.resourceUri,`ui://codex-design/${manifest.version}/library`);
  const ui=await rpc('resources/read',{uri:entry._meta.ui.resourceUri});
  assert.match(ui.contents[0].text,/codex-design-root/);
  assert.doesNotMatch(ui.contents[0].text,/<script[^>]+src=|<link[^>]+rel=["']stylesheet/);
  console.log(JSON.stringify({verified:true,pluginVersion:manifest.version,uiResourceUri:entry._meta.ui.resourceUri,relocatedPackage:relocated,command:server.command,cwdFromPluginRoot:true,nodeModulesRequired:false,toolCount:tools.tools.length,resourceCount:resources.resources.length,uiBytes:Buffer.byteLength(ui.contents[0].text)},null,2));
} finally {
  for(const call of pending.values())clearTimeout(call.timer);
  lines.close();child.stdin.end();child.kill();
}
