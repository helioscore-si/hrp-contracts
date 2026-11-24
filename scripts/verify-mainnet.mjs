// Read-only RPC verification. No signer, private key, transaction or deployment.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import solc from 'solc';
import {JsonRpcProvider, FetchRequest, Contract, toBeHex, keccak256} from 'ethers';
const root=path.resolve(import.meta.dirname,'..');
const sources={};
function walk(dir){for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
 const file=dir+'/'+e.name;
 if(e.isDirectory())walk(file);else if(file.endsWith('.sol'))sources[file]={content:fs.readFileSync(path.join(root,file),'utf8')};
}}
walk('contracts');
const settings={optimizer:{enabled:true,runs:200},evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences','metadata'],'':['ast']}}};
const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings}),{import(name){
 const file=path.resolve(root,'node_modules',name);
 if(!file.startsWith(path.join(root,'node_modules')+path.sep))return {error:'Invalid import'};
 return {contents:fs.readFileSync(file,'utf8')};
}}));
if(output.errors?.some(e=>e.severity==='error'))throw Error(JSON.stringify(output.errors));
const names=new Map();
function visit(value){if(!value||typeof value!=='object')return;if(value.nodeType==='VariableDeclaration')names.set(String(value.id),value.name);for(const v of Object.values(value))if(typeof v==='object')visit(v);}
visit(output.sources);
const req=new FetchRequest(process.env.BSC_RPC_URL||'https://bsc-dataseed.bnbchain.org');req.timeout=15000;
const provider=new JsonRpcProvider(req,undefined,{batchMaxCount:1});
try{
 if((await provider.getNetwork()).chainId!==56n)throw Error('Expected BSC mainnet chain ID 56');
 const block=await provider.getBlock('latest');
 const addresses={HRPToken:'0x4c1B827fB12033f67BA0Cc2B5E56acbd777FF1A4',TokenSale:'0x36BE17219da82f050e7A17B69e6C9da293614074'};
 const report={chainId:56,blockNumber:block.number,blockHash:block.hash,checkedAt:new Date().toISOString(),compiler:solc.version(),optimizer:settings.optimizer,evmVersion:settings.evmVersion,independentAudit:false,contracts:{}};
 for(const [name,address]of Object.entries(addresses)){
  const compiled=output.contracts['contracts/'+name+'.sol'][name];
  const contract=new Contract(address,compiled.abi,provider);
  let expected=compiled.evm.deployedBytecode.object;
  const immutables={};
  for(const [id,slots]of Object.entries(compiled.evm.deployedBytecode.immutableReferences)){
   const field=names.get(id);if(!field)throw Error('Unknown immutable '+id);
   const value=await contract[field]({blockTag:block.number});immutables[field]=String(value);
   for(const {start,length}of slots){const hex=toBeHex(value,length).slice(2);expected=expected.slice(0,start*2)+hex+expected.slice((start+length)*2);}
  }
  const actual=await provider.getCode(address,block.number);
  if(actual.toLowerCase()!==('0x'+expected).toLowerCase())throw Error('Deployed runtime mismatch: '+name);
  const state={owner:await contract.owner({blockTag:block.number})};
  for(const field of name==='HRPToken'?['name','symbol','decimals','totalSupply','sale','transfersEnabled','transferPolicyRevision']:['treasury','paused','currentRound','admissionSigner','settlementOperator','externalLotLimit']){
   const value=await contract[field]({blockTag:block.number});state[field]=typeof value==='bigint'?value.toString():value;
  }
  if(name==='TokenSale'){
   state.roundCapsLots=[];state.bonusRatesBps=[];
   for(let i=0;i<5;i++){state.roundCapsLots.push(String(await contract.roundCapsLots(i,{blockTag:block.number})));state.bonusRatesBps.push(String(await contract.bonusRatesBps(i,{blockTag:block.number})));}
  }
  report.contracts[name]={address,exactRuntimeMatch:true,runtimeKeccak256:keccak256(actual),sourceSHA256:crypto.createHash('sha256').update(sources['contracts/'+name+'.sol'].content).digest('hex'),immutables,state};
 }
 report.sharedOwner=report.contracts.HRPToken.state.owner.toLowerCase()===report.contracts.TokenSale.state.owner.toLowerCase();
 report.governance=[];
 for(const owner of new Set(Object.values(report.contracts).map(c=>c.state.owner))){
  const safe=new Contract(owner,['function getThreshold() view returns(uint256)','function getOwners() view returns(address[])','function getModulesPaginated(address,uint256) view returns(address[],address)'],provider);
  const [modules,next]=await safe.getModulesPaginated('0x0000000000000000000000000000000000000001',100,{blockTag:block.number});
  report.governance.push({address:owner,threshold:String(await safe.getThreshold({blockTag:block.number})),owners:Array.from(await safe.getOwners({blockTag:block.number})),modules:Array.from(modules),next});
 }
 report.warnings=report.sharedOwner?[]:['Token and sale have different owners at this block. Sale methods using _requireGovernance require matching ownership; this report does not change that state.'];
 fs.mkdirSync(path.join(root,'deployments'),{recursive:true});
 fs.writeFileSync(path.join(root,'deployments/bsc-mainnet.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await provider.destroy();}
