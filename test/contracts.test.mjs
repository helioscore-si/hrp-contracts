import {describe,test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.UWS_USE_FALLBACK='1';
const {default:ganache}=await import('ganache');
import {preparePurchase,readPurchaseReceipt} from '../integration/purchase-client.mjs';
import {quoteBonus} from './reference-bonus.mjs';
import {verifyPurchase,findPurchaseHash} from '../server/receipt-verifier.mjs';
import {BrowserProvider,ContractFactory,parseUnits,id,ZeroHash,ZeroAddress,MaxUint256} from 'ethers';
const readArtifact=name=>JSON.parse(fs.readFileSync(new URL(`../artifacts/${name}.json`,import.meta.url)));
const H=value=>parseUnits(String(value),18);
const caps=[2000n,6000n,8000n,10000n,1000n];
const rates=[10000,6000,4000,2000,1000];
const inventory=H(3790000);
let rpc,provider,signers,addresses,base,snapshot,orderCounter=0;
const deploymentGas={};
const tx=async promise=>(await promise).wait();
async function deploy(name,args){
 const a=readArtifact(name); const c=await new ContractFactory(a.abi,a.bytecode,signers[0]).deploy(...args);
 const receipt=await c.deploymentTransaction().wait();
 deploymentGas[name]=receipt.gasUsed.toString(); return c;
}
async function fixture({decimals=6,supply=20000000,setupOverride={},customCaps=caps,
 customRates=rates,fund=true,activate=true,tokenName='HRPToken',failingBalance=inventory}={}){
 const token=tokenName==='HRPToken'
  ? await deploy(tokenName,['HELIOS PRIME — LOCAL TEST',H(supply),addresses[1],addresses[2],H(400000),addresses[0]])
  : await deploy(tokenName,[addresses[1],addresses[2]]);
 const payment=await deploy('MockUSDT',[decimals]);
 const block=await provider.getBlock('latest');
 const setup={administrator:addresses[0],paymentToken:await payment.getAddress(),treasury:addresses[3],
  hrp:await token.getAddress(),paymentDecimals:decimals,closesAt:BigInt(block.timestamp+86400),inventory,...setupOverride};
 const sale=await deploy('TokenSale',[setup,customCaps,customRates]);
 if(fund){
  if(tokenName==='HRPToken')await tx(token.initializeSale(await sale.getAddress()));
  else await tx(token.bind(await sale.getAddress(),failingBalance));
 }
 for(const i of [4,5]){
  await tx(sale.setEligible(addresses[i],true));
  await tx(payment.mint(addresses[i],parseUnits('10000000',decimals)));
  await tx(payment.connect(signers[i]).approve(await sale.getAddress(),MaxUint256));
 }
 if(activate)await tx(sale.unpause());
 return {token,payment,sale,setup,decimals};
}
async function buy(f=base,{buyer=4,lots=10n,round,order,deadline,minOut,gasLimit}={}){
 const q=await f.sale.quote(addresses[buyer],lots);
 return tx(f.sale.connect(signers[buyer]).buy(lots,round??q.round,order??id(`order-${++orderCounter}`),
  deadline??f.setup.closesAt-1n,minOut??q.totalHRP,...(gasLimit?[{gasLimit}]:[])));
}
async function staticBuy(f=base,{buyer=4,lots=10n,round=0,order=id('static'),deadline=f.setup.closesAt-1n,minOut=0n}={}){
 return f.sale.connect(signers[buyer]).buy.staticCall(lots,round,order,deadline,minOut);
}
function errorData(error){return error.data??error.info?.error?.data?.result??error.info?.error?.data;}
async function expectError(contract,promise,name){
 let error; try{await promise;}catch(e){error=e;}
 assert.ok(error,`Expected ${name}`);
 const data=errorData(error);
 assert.equal(contract.interface.parseError(typeof data==='object'?data.result:data)?.name,name);
}
async function state(f=base){
 return {buyerHRP:await f.token.balanceOf(addresses[4]),inventory:await f.token.balanceOf(await f.sale.getAddress()),
 buyerUSDT:await f.payment.balanceOf(addresses[4]),treasuryUSDT:await f.payment.balanceOf(addresses[3]),
 allowance:await f.payment.allowance(addresses[4],await f.sale.getAddress()),
 buyer:Array.from(await f.sale.buyers(addresses[4])),sold:await f.sale.soldLots(0)};
}

describe('HRP contracts: local EVM only',()=>{
 before(async()=>{
  rpc=ganache.provider({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai'},wallet:{totalAccounts:8},miner:{blockGasLimit:30000000}});
  provider=new BrowserProvider(rpc,undefined,{cacheTimeout:-1}); provider.pollingInterval=10;
  signers=await Promise.all(Array.from({length:8},(_,i)=>provider.getSigner(i)));
  addresses=await Promise.all(signers.map(s=>s.getAddress()));
  base=await fixture(); snapshot=await rpc.request({method:'evm_snapshot',params:[]});
 });
 beforeEach(async()=>{
  assert.equal(await rpc.request({method:'evm_revert',params:[snapshot]}),true);
  snapshot=await rpc.request({method:'evm_snapshot',params:[]});
 });
 after(async()=>{
  fs.writeFileSync(new URL('../reports/local-deployment-gas.json',import.meta.url),JSON.stringify({
   note:'Local mock-based build only; not a production gas quote.',gas:deploymentGas},null,2));
  await provider.destroy(); await rpc.disconnect();
 });
 test('Fixed initial supply and isolated reserve are consistent',async()=>{
  assert.equal(await base.token.totalSupply(),H(20000000));
  assert.equal(await base.token.balanceOf(addresses[2]),H(400000));
  assert.equal(await base.token.balanceOf(addresses[1]),H(15810000));
  assert.equal(await base.token.balanceOf(await base.sale.getAddress()),inventory);
  assert.equal(await base.sale.requiredInventory(),inventory);
  const abi=base.token.interface.fragments.filter(x=>x.type==='function').map(x=>x.name);
  for(const forbidden of ['mint','burn','upgradeTo','upgradeToAndCall'])assert.ok(!abi.includes(forbidden));
 });
 test('Approved 20m is enforced in bytecode; other emissions are rejected at creation',async()=>{
  for(const supply of [0,19999999,20000001,50000000])await assert.rejects(deploy('HRPToken',['INVALID SUPPLY',H(supply),addresses[1],addresses[2],H(400000),addresses[0]]));
  assert.equal(await base.token.TOTAL_SUPPLY(),H(20000000));
 });
 test('USDT goes directly to treasury and paid plus bonus HRP to buyer',async()=>{
  const receipt=await buy();
  assert.equal(await base.token.balanceOf(addresses[4]),H(2000));
  assert.equal(await base.payment.balanceOf(addresses[3]),parseUnits('1000',6));
  assert.equal(await base.payment.balanceOf(await base.sale.getAddress()),0n);
  const event=receipt.logs.map(l=>{try{return base.sale.interface.parseLog(l)}catch{return null}}).find(x=>x?.name==='Purchased');
  assert.equal(event.args.buyer,addresses[4]); assert.equal(event.args.paidHRP,H(1000));
  assert.equal(event.args.bonusHRP,H(1000)); assert.equal(event.args.round,0n);
  const balances=await Promise.all([addresses[1],addresses[2],addresses[4],await base.sale.getAddress()].map(a=>base.token.balanceOf(a)));
  assert.equal(balances.reduce((a,b)=>a+b,0n),await base.token.totalSupply());
 });
 test('USDT with 18 decimals is supported explicitly',async()=>{
  const f=await fixture({decimals:18}); await buy(f);
  assert.equal(await f.payment.balanceOf(addresses[3]),parseUnits('1000',18));
  assert.equal(await f.token.balanceOf(addresses[4]),H(2000));
 });
 test('Approval alone does not buy HRP or increase paid lots',async()=>{
  assert.equal(await base.token.balanceOf(addresses[4]),0n);
  assert.equal((await base.sale.buyers(addresses[4])).paidLots,0n);
 });
 test('No bonus before 10 accumulated lots; the crossing pays on all ten',async()=>{
  await buy(base,{lots:9n}); assert.equal(await base.token.balanceOf(addresses[4]),H(900));
  await buy(base,{lots:1n}); assert.equal(await base.token.balanceOf(addresses[4]),H(2000));
 });
 test('Cross-round source example: 2 + 3 + 5 lots yields 1400 HRP',async()=>{
  await buy(base,{lots:2n}); await tx(base.sale.advanceRound());
  await buy(base,{lots:3n}); await tx(base.sale.advanceRound());
  await buy(base,{lots:5n});
  assert.equal(await base.token.balanceOf(addresses[4]),H(1400));
  assert.equal((await base.sale.buyers(addresses[4])).bonusHRP,H(400));
 });
 test('Crossing above threshold counts all eleven lots',async()=>{
  await buy(base,{lots:8n}); await tx(base.sale.advanceRound()); await buy(base,{lots:3n});
  assert.equal((await base.sale.buyers(addresses[4])).bonusHRP,H(660));
 });
 test('After threshold only new payment gets the current rate',async()=>{
  await buy(); await tx(base.sale.advanceRound()); await buy(base,{lots:1n});
  assert.equal((await base.sale.buyers(addresses[4])).bonusHRP,H(1060));
 });
 test('A 15000 USDT purchase has no arbitrary 10000 cap',async()=>{
  await buy(base,{lots:150n}); assert.equal((await base.sale.buyers(addresses[4])).paidUSDT,parseUnits('15000',6));
 });
 test('Accumulation is isolated per wallet',async()=>{
  await buy(base,{lots:9n}); await buy(base,{buyer:5,lots:1n});
  assert.equal((await base.sale.buyers(addresses[4])).bonusHRP,0n);
  assert.equal((await base.sale.buyers(addresses[5])).bonusHRP,0n);
 });
 test('Same wallet and order cannot be executed twice; different wallet has its namespace',async()=>{
  const order=id('same-order'); await buy(base,{order});
  await expectError(base.sale,staticBuy(base,{order}),'InvalidOrder');
  await buy(base,{buyer:5,order}); assert.equal(await base.token.balanceOf(addresses[5]),H(2000));
 });
 test('Zero order and zero lots are rejected',async()=>{
  await expectError(base.sale,staticBuy(base,{order:ZeroHash}),'InvalidOrder');
  await expectError(base.sale,staticBuy(base,{lots:0n}),'InvalidLots');
 });
 test('Direct purchase requires admission and revocation takes effect',async()=>{
  await expectError(base.sale,staticBuy(base,{buyer:6}),'NotEligible');
  await tx(base.sale.setEligible(addresses[4],false));
  await expectError(base.sale,staticBuy(),'NotEligible');
 });
 test('Buyer cannot silently receive a changed round rate',async()=>{
  await tx(base.sale.advanceRound()); await expectError(base.sale,staticBuy(),'StaleRound');
 });
 test('Quote deadline and minimum output are enforced',async()=>{
  await expectError(base.sale,staticBuy(base,{deadline:1n}),'QuoteExpired');
  await expectError(base.sale,staticBuy(base,{minOut:H(2001)}),'MinimumOutputNotMet');
 });
 test('Round capacity counts paid lots only and rejects exceeding remaining capacity',async()=>{
  await buy(base,{lots:2000n}); assert.equal(await base.sale.soldLots(0),2000n);
  await expectError(base.sale,staticBuy(base,{lots:1n}),'RoundCapExceeded');
 });
 test('Rounds advance only forward to the fifth round',async()=>{
  for(let i=0;i<4;i++)await tx(base.sale.advanceRound());
  assert.equal(await base.sale.currentRound(),4n);
  await expectError(base.sale,base.sale.advanceRound.staticCall(),'LastRound');
 });
 test('Sale is closed at the exact closing timestamp',async()=>{
  await rpc.request({method:'evm_setTime',params:[Number(base.setup.closesAt)*1000]});
  await rpc.request({method:'evm_mine',params:[]});
  await expectError(base.sale,staticBuy(),'SaleClosed');
  await expectError(base.sale,base.sale.advanceRound.staticCall(),'SaleClosed');
 });
 test('Pause stops purchases; unpause resumes',async()=>{
  await tx(base.sale.pause()); await expectError(base.sale,staticBuy(),'EnforcedPause');
  await tx(base.sale.unpause()); await buy();
 });
 test('Unbound sale cannot be opened; only owner can fund once',async()=>{
  const f=await fixture({fund:false,activate:false});
  await expectError(f.sale,f.sale.unpause.staticCall(),'SaleNotBound');
  await expectError(f.token,f.token.connect(signers[4]).initializeSale.staticCall(await f.sale.getAddress()),'OwnableUnauthorizedAccount');
  await tx(f.token.initializeSale(await f.sale.getAddress()));
  await expectError(f.token,f.token.initializeSale.staticCall(await f.sale.getAddress()),'SaleAlreadyBound');
 });
 test('Owner privileges cannot be used by a buyer',async()=>{
  await expectError(base.sale,base.sale.connect(signers[4]).setEligible.staticCall(addresses[6],true),'OwnableUnauthorizedAccount');
  await expectError(base.sale,base.sale.connect(signers[4]).advanceRound.staticCall(),'OwnableUnauthorizedAccount');
  await expectError(base.sale,base.sale.connect(signers[4]).pause.staticCall(),'OwnableUnauthorizedAccount');
 });
 test('Ownership is transferred in two steps; renouncing is disabled',async()=>{
  await tx(base.sale.transferOwnership(addresses[5])); assert.equal(await base.sale.owner(),addresses[0]);
  await expectError(base.sale,base.sale.connect(signers[4]).acceptOwnership.staticCall(),'OwnableUnauthorizedAccount');
  await tx(base.sale.connect(signers[5]).acceptOwnership()); assert.equal(await base.sale.owner(),addresses[5]);
  await expectError(base.sale,base.sale.connect(signers[5]).renounceOwnership.staticCall(),'GovernanceRequired');
  await expectError(base.token,base.token.renounceOwnership.staticCall(),'GovernanceRequired');
 });
 test('Plain P2P, transferFrom and company/reserve transfers cannot bypass hold',async()=>{
  await buy();
  await expectError(base.token,base.token.connect(signers[4]).transfer.staticCall(addresses[5],H(1)),'TransfersLocked');
  await tx(base.token.connect(signers[4]).approve(addresses[5],H(100)));
  await expectError(base.token,base.token.connect(signers[5]).transferFrom.staticCall(addresses[4],addresses[5],H(1)),'TransfersLocked');
  for(const i of [1,2])await expectError(base.token,base.token.connect(signers[i]).transfer.staticCall(addresses[4],H(1)),'TransfersLocked');
  await expectError(base.token,base.token.deliver.staticCall(addresses[4],H(1)),'UnauthorizedRoute');
 });
 test('Missing USDT allowance reverts without financial state changes',async()=>{
  await tx(base.payment.connect(signers[4]).approve(await base.sale.getAddress(),0)); const prior=await state();
  const order=id('no-allowance');
  await assert.rejects(buy(base,{order,gasLimit:1000000}));
  assert.deepEqual(await state(),prior); assert.equal(await base.sale.usedOrders(addresses[4],order),false);
 });
 test('Insufficient USDT balance reverts all counters',async()=>{
  const wallet=base.payment.connect(signers[4]); await tx(wallet.transfer(addresses[6],await wallet.balanceOf(addresses[4])));
  const prior=await state(); await assert.rejects(buy(base,{gasLimit:1000000})); assert.deepEqual(await state(),prior);
 });
 test('False-returning payment token rolls back the entire purchase',async()=>{
  await tx(base.payment.setMode(1)); const prior=await state();
  await expectError(base.sale,staticBuy(),'SafeERC20FailedOperation');
  await assert.rejects(buy(base,{gasLimit:1000000})); assert.deepEqual(await state(),prior);
 });
 test('Fee-on-transfer payment is rejected and rolled back',async()=>{
  await tx(base.payment.setMode(2)); const prior=await state();
  await expectError(base.sale,staticBuy(),'UnexpectedPaymentAmount');
  await assert.rejects(buy(base,{gasLimit:1000000})); assert.deepEqual(await state(),prior);
 });
 test('No-return-data USDT style is accepted by SafeERC20',async()=>{
  await tx(base.payment.setMode(5)); await buy(); assert.equal(await base.token.balanceOf(addresses[4]),H(2000));
 });
 test('Reentrant buy is blocked even when external token swallows its failure',async()=>{
  const payload=base.sale.interface.encodeFunctionData('buy',[1n,0,id('reentrant'),base.setup.closesAt-1n,0n]);
  await tx(base.payment.setReentry(await base.sale.getAddress(),payload)); await tx(base.payment.setMode(3));
  await buy(); assert.equal(await base.payment.reentrySucceeded(),false);
  assert.equal(base.sale.interface.parseError(await base.payment.reentryResult()).name,'ReentrancyGuardReentrantCall');
  assert.equal((await base.sale.buyers(addresses[4])).paidLots,10n);
 });
 test('A propagated reentrancy failure rolls back the outer transaction',async()=>{
  const payload=base.sale.interface.encodeFunctionData('buy',[1n,0,id('reentrant'),base.setup.closesAt-1n,0n]);
  await tx(base.payment.setReentry(await base.sale.getAddress(),payload)); await tx(base.payment.setMode(4));
  const prior=await state(); await assert.rejects(buy(base,{gasLimit:1000000})); assert.deepEqual(await state(),prior);
 });
 test('Failure delivering HRP rolls back USDT already transferred in the same transaction',async()=>{
  const f=await fixture({tokenName:'MockFailingHRP'}); const prior=await state(f); const order=id('late-error');
  await assert.rejects(buy(f,{order,gasLimit:1000000})); assert.deepEqual(await state(f),prior);
  assert.equal(await f.sale.usedOrders(addresses[4],order),false);
 });
 test('Inventory check includes bonuses before attempting payment',async()=>{
  const f=await fixture({tokenName:'MockFailingHRP',failingBalance:H(1999)}); const prior=await state(f);
  await expectError(f.sale,staticBuy(f),'InsufficientInventory'); assert.deepEqual(await state(f),prior);
 });
 test('The underfunded 3.6m plan fails construction before opening sales',async()=>{
  await assert.rejects(deploy('TokenSale',[{...base.setup,inventory:H(3600000)},caps,rates]));
 });
 test('Decimals mismatch, increasing rates and empty cap fail configuration',async()=>{
  await assert.rejects(deploy('TokenSale',[{...base.setup,paymentDecimals:18},caps,rates]));
  await assert.rejects(deploy('TokenSale',[base.setup,caps,[10000,4000,6000,2000,1000]]));
  await assert.rejects(deploy('TokenSale',[base.setup,[2000,6000,8000,10000,0],rates]));
 });
 test('Treasury and project reserve cannot be admitted as buyers',async()=>{
  for(const i of [1,2,3]) await expectError(base.sale,base.sale.setEligible.staticCall(addresses[i],true),'InvalidConfiguration');
 });
 test('Buyback hook is initially closed and requires holder allowance to its operator',async()=>{
  await buy(); assert.equal(await base.token.buybackOperator(),ZeroAddress);
  await expectError(base.token,base.token.settleBuyback.staticCall(addresses[4],H(10)),'UnauthorizedRoute');
  const operator=await deploy('MockBuybackOperator',[await base.token.getAddress()]);
  await tx(base.token.configureBuybackOperator(await operator.getAddress()));
  await assert.rejects(operator.settle.staticCall(addresses[4],H(10)));
  await tx(base.token.connect(signers[4]).approve(await operator.getAddress(),H(10)));
  const companyBefore=await base.token.balanceOf(addresses[1]);
  await tx(operator.settle(addresses[4],H(10)));
  assert.equal(await base.token.balanceOf(addresses[1]),companyBefore+H(10));
  assert.equal(await base.token.allowance(addresses[4],await operator.getAddress()),0n);
  assert.equal(await base.token.balanceOf(addresses[2]),H(400000));
  await expectError(base.token,base.token.configureBuybackOperator.staticCall(await operator.getAddress()),'BuybackAlreadyConfigured');
 });
 test('Disabling buyback closes the hook permanently',async()=>{
  const operator=await deploy('MockBuybackOperator',[await base.token.getAddress()]);
  await tx(base.token.configureBuybackOperator(await operator.getAddress())); await tx(base.token.disableBuybackOperator());
  await expectError(base.token,base.token.configureBuybackOperator.staticCall(await operator.getAddress()),'BuybackAlreadyConfigured');
  await assert.rejects(operator.settle.staticCall(addresses[4],1n));
 });
 test('A failed buy can be retried with the same order after fixing allowance',async()=>{
  const order=id('retry'); await tx(base.payment.connect(signers[4]).approve(await base.sale.getAddress(),0));
  await assert.rejects(buy(base,{order,gasLimit:1000000}));
  await tx(base.payment.connect(signers[4]).approve(await base.sale.getAddress(),MaxUint256));
  await buy(base,{order}); assert.equal(await base.sale.usedOrders(addresses[4],order),true);
 });

 test('Approved five rounds can sell every paid lot and maximum bonus with no shortage or extra supply',async()=>{
  const expectedBonus=[200000,360000,320000,200000,10000];
  for(let round=0;round<5;round++){
   if(round)await tx(base.sale.advanceRound());
   const quote=await base.sale.quote(addresses[4],caps[round]);
   assert.equal(quote.paidHRP,H(caps[round]*100n));assert.equal(quote.bonusHRP,H(expectedBonus[round]));
   await buy(base,{lots:caps[round],round});assert.equal(await base.sale.soldLots(round),caps[round]);
  }
  const buyer=await base.sale.buyers(addresses[4]);assert.equal(buyer.paidLots,27000n);assert.equal(buyer.bonusHRP,H(1090000));
  assert.equal(buyer.paidUSDT,parseUnits('2700000',6));assert.equal(await base.payment.balanceOf(addresses[3]),parseUnits('2700000',6));
  assert.equal(await base.token.balanceOf(addresses[4]),H(3790000));assert.equal(await base.token.balanceOf(await base.sale.getAddress()),0n);
  assert.equal(await base.token.balanceOf(addresses[1]),H(15810000));assert.equal(await base.token.balanceOf(addresses[2]),H(400000));assert.equal(await base.token.totalSupply(),H(20000000));
  const before=await state();await expectError(base.sale,staticBuy(base,{lots:1n,round:4}),'RoundCapExceeded');assert.deepEqual(await state(),before);
 });
 test('Late threshold uses the shared bonus reserve and is not capped to the last-round new-purchase bonus',async()=>{
  await buy(base,{lots:9n});assert.equal((await base.sale.buyers(addresses[4])).bonusHRP,0n);
  for(let r=0;r<4;r++)await tx(base.sale.advanceRound());
  const quote=await base.sale.quote(addresses[4],1n);assert.equal(quote.paidHRP,H(100));assert.equal(quote.bonusHRP,H(100));
  await buy(base,{lots:1n,round:4});assert.equal(await base.token.balanceOf(addresses[4]),H(1100));
  assert.equal((await base.sale.buyers(addresses[4])).paidLots,10n);assert.equal((await base.sale.buyers(addresses[4])).bonusHRP,H(100));
  assert.equal(await base.token.balanceOf(await base.sale.getAddress()),H(3790000-1100));assert.equal(await base.token.totalSupply(),H(20000000));
 });
 test('Seeded cross-round purchases agree with the independent offline model and conserve supply',async()=>{
  const paid=[0n,0n],expectedBalances=[0n,0n]; let seed=384919;
  for(let round=0;round<5;round++){
   if(round)await tx(base.sale.advanceRound());
   for(let step=0;step<3;step++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const index=seed%2, lots=BigInt(1+(seed%9));
    const q=quoteBonus(paid[index],lots,BigInt(rates[round]));
    paid[index]=q.totalPaidLots; expectedBalances[index]+=H(q.deliveredHRP);
    await buy(base,{buyer:4+index,lots});
    assert.equal(await base.token.balanceOf(addresses[4+index]),expectedBalances[index]);
   }
  }
  const wallets=[addresses[1],addresses[2],addresses[4],addresses[5],await base.sale.getAddress()];
  const total=(await Promise.all(wallets.map(a=>base.token.balanceOf(a)))).reduce((a,b)=>a+b,0n);
  assert.equal(total,await base.token.totalSupply());
  assert.equal(await base.token.balanceOf(addresses[2]),H(400000));
 });
 async function clientOptions(f=base){return {provider,buyer:addresses[4],lots:10n,orderId:id('client-order'),
  deployment:{chainId:31337,saleAddress:await f.sale.getAddress(),tokenAddress:await f.token.getAddress(),paymentTokenAddress:await f.payment.getAddress()}};}
 test('Client prepares an unsigned exact-amount approval and buy without moving funds',async()=>{
  await tx(base.payment.connect(signers[4]).approve(await base.sale.getAddress(),0));
  const prior=await state(),options=await clientOptions(); const plan=await preparePurchase(options);
  assert.equal(plan.approvals.length,1); assert.equal(plan.totalHRP,H(2000));
  const approve=base.payment.interface.parseTransaction(plan.approvals[0]); assert.equal(approve.args[1],parseUnits('1000',6));
  const purchase=base.sale.interface.parseTransaction(plan.purchase);
  assert.equal(purchase.args.expectedRound,0n); assert.equal(purchase.args.minHRPOut,H(2000));
  assert.deepEqual(await state(),prior);
 });
 test('Client handles existing nonzero USDT allowance with zero-then-exact approvals',async()=>{
  await tx(base.payment.connect(signers[4]).approve(await base.sale.getAddress(),1n));
  const plan=await preparePurchase(await clientOptions()); assert.equal(plan.approvals.length,2);
  assert.equal(base.payment.interface.parseTransaction(plan.approvals[0]).args[1],0n);
  assert.equal(base.payment.interface.parseTransaction(plan.approvals[1]).args[1],parseUnits('1000',6));
 });
 test('Client skips approval when allowance is sufficient',async()=>{
  assert.equal((await preparePurchase(await clientOptions())).approvals.length,0);
 });
 test('Client rejects wrong network and mismatched contract addresses',async()=>{
  const o=await clientOptions();
  await assert.rejects(preparePurchase({...o,deployment:{...o.deployment,chainId:56}}),/WRONG_CHAIN/);
  await assert.rejects(preparePurchase({...o,deployment:{...o.deployment,paymentTokenAddress:o.deployment.tokenAddress}}),/DEPLOYMENT_ADDRESS_MISMATCH/);
 });
 test('Client refuses paused or unadmitted purchase',async()=>{
  const o=await clientOptions(); await tx(base.sale.pause());
  await assert.rejects(preparePurchase(o),/SALE_PAUSED/); await tx(base.sale.unpause());
  await tx(base.sale.setEligible(addresses[4],false)); await assert.rejects(preparePurchase(o),/NOT_ELIGIBLE/);
 });
 test('Client only accepts a successful matching purchase event, not an approval',async()=>{
  const o=await clientOptions(); const approval=await tx(base.payment.connect(signers[4]).approve(await base.sale.getAddress(),MaxUint256));
  assert.throws(()=>readPurchaseReceipt({...o,receipt:approval}),/NOT_A_SUCCESSFUL_PURCHASE/);
  const receipt=await buy(base,{order:o.orderId}); const parsed=readPurchaseReceipt({...o,receipt});
  assert.equal(parsed.paidHRP,H(1000)); assert.equal(parsed.bonusHRP,H(1000));
  assert.throws(()=>readPurchaseReceipt({...o,receipt,orderId:id('wrong')}),/PURCHASE_EVENT/);
  assert.throws(()=>readPurchaseReceipt({...o,receipt:{...receipt,status:0}}),/NOT_A_SUCCESSFUL_PURCHASE/);
  await assert.rejects(preparePurchase(o),/ORDER_ALREADY_USED/);
 });
 test('Client rejects number/zero lots and invalid order IDs',async()=>{
  const o=await clientOptions();
  await assert.rejects(preparePurchase({...o,lots:10}),/WHOLE_POSITIVE/);
  await assert.rejects(preparePurchase({...o,lots:0n}),/WHOLE_POSITIVE/);
  await assert.rejects(preparePurchase({...o,orderId:ZeroHash}),/INVALID_ORDER/);
 });

 async function verifyOptions(receipt,order){return {provider,deployment:{chainId:31337,confirmations:1,fromBlock:0,
  saleAddress:await base.sale.getAddress(),tokenAddress:await base.token.getAddress(),paymentTokenAddress:await base.payment.getAddress()},
  txHash:receipt.hash,boundWallet:addresses[4],expectedOrderId:order};}
 test('Server verifier checks successful buy plus both transfer events',async()=>{
  const order=id('verify-ok'),r=await buy(base,{order}),o=await verifyOptions(r,order);
  const result=await verifyPurchase(o);assert.equal(result.status,'confirmed');assert.equal(result.paidHRP,H(1000).toString());
  assert.equal(result.bonusHRP,H(1000).toString());assert.equal(result.buyer,addresses[4]);
  assert.deepEqual(await verifyPurchase(o),result);
  assert.equal(await findPurchaseHash({provider,deployment:o.deployment,boundWallet:addresses[4],orderId:order}),r.hash);
 });
 test('Server verifier rejects different wallet, order, network and payment address',async()=>{
  const order=id('verify-wrong'),r=await buy(base,{order}),o=await verifyOptions(r,order);
  await assert.rejects(verifyPurchase({...o,boundWallet:addresses[5]}),/TRANSACTION_OWNER_MISMATCH/);
  await assert.rejects(verifyPurchase({...o,expectedOrderId:id('wrong')}),/ORDER_MISMATCH/);
  await assert.rejects(verifyPurchase({...o,deployment:{...o.deployment,chainId:56}}),/WRONG_CHAIN/);
  await assert.rejects(verifyPurchase({...o,deployment:{...o.deployment,paymentTokenAddress:await base.token.getAddress()}}),/DEPLOYMENT_ADDRESS_MISMATCH/);
 });
 test('Server verifier does not mistake an approval for a purchase',async()=>{
  const r=await tx(base.payment.connect(signers[4]).approve(await base.sale.getAddress(),1000n));
  await assert.rejects(verifyPurchase(await verifyOptions(r,id('approval'))),/TRANSACTION_OWNER_MISMATCH/);
 });
 test('Not mined and insufficient confirmations remain pending without credit',async()=>{
  const order=id('verify-pending'),r=await buy(base,{order}),o=await verifyOptions(r,order);
  assert.equal((await verifyPurchase({...o,txHash:id('absent')})).status,'pending');
  assert.equal((await verifyPurchase({...o,deployment:{...o.deployment,confirmations:100}})).status,'confirming');
 });
 test('Server refuses a receipt when its block is no longer canonical',async()=>{
  const order=id('verify-reorg'),r=await buy(base,{order}),o=await verifyOptions(r,order);
  const wrapped=new Proxy(provider,{get(target,key){if(key==='getBlock')return async n=>({...await target.getBlock(n),hash:id('replacement-block')});const v=target[key];return typeof v==='function'?v.bind(target):v;}});
  assert.equal((await verifyPurchase({...o,provider:wrapped})).reason,'reorg');
 });
 test('Server refuses incomplete financial evidence even with a Purchased event',async()=>{
  const order=id('verify-transfers'),r=await buy(base,{order}),o=await verifyOptions(r,order);
  const wrapped=new Proxy(provider,{get(target,key){if(key==='getTransactionReceipt')return async hash=>{const receipt=await target.getTransactionReceipt(hash);return {...receipt,logs:receipt.logs.filter(l=>l.address.toLowerCase()!==o.deployment.paymentTokenAddress.toLowerCase())};};const v=target[key];return typeof v==='function'?v.bind(target):v;}});
  await assert.rejects(verifyPurchase({...o,provider:wrapped}),/TRANSFER_MISMATCH/);
 });
});
