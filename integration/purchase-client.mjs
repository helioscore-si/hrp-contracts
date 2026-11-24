// Preparation-only API: returns unsigned transaction requests; never signs or broadcasts.
import {Contract,Interface,getAddress,isHexString,ZeroAddress,ZeroHash,verifyTypedData} from 'ethers';
import {hrpAbi,saleAbi} from './abi.mjs';
import {admissionTypes,admissionDomain} from './admission.mjs';
const erc20Abi=['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)'];
const address=value=>{const result=getAddress(value);if(result===ZeroAddress)throw new Error('ZERO_ADDRESS');return result};
export async function preparePurchase({provider,deployment,buyer,lots,orderId,ttlSeconds=300,permit}) {
 if(typeof lots!=='bigint'||lots<=0n)throw new Error('WHOLE_POSITIVE_LOTS_REQUIRED');
 if(!isHexString(orderId,32)||orderId===ZeroHash)throw new Error('INVALID_ORDER');
 if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<=0||ttlSeconds>3600)throw new Error('INVALID_QUOTE_TTL');
 const wallet=address(buyer),saleAddress=address(deployment.saleAddress),tokenAddress=address(deployment.tokenAddress),paymentAddress=address(deployment.paymentTokenAddress);
 const network=await provider.getNetwork();
 if(network.chainId!==BigInt(deployment.chainId))throw new Error('WRONG_CHAIN');
 const sale=new Contract(saleAddress,saleAbi,provider);
 const token=new Contract(tokenAddress,hrpAbi,provider);
 const payment=new Contract(paymentAddress,erc20Abi,provider);
 const [actualToken,actualPayment,boundSale]=await Promise.all([sale.token(),sale.paymentToken(),token.sale()]);
 if(getAddress(actualToken)!==tokenAddress||getAddress(actualPayment)!==paymentAddress||getAddress(boundSale)!==saleAddress)
  throw new Error('DEPLOYMENT_ADDRESS_MISMATCH');
 const [isPaused,isEligible,used,closeTime,block,q,allowance,balance]=await Promise.all([
  sale.paused(),sale.eligible(wallet),sale.usedOrders(wallet,orderId),sale.closesAt(),provider.getBlock('latest'),
  sale.quote(wallet,lots),payment.allowance(wallet,saleAddress),payment.balanceOf(wallet)]);
 if(isPaused)throw new Error('SALE_PAUSED');
 if(!permit&&!isEligible)throw new Error('NOT_ELIGIBLE');
 if(used)throw new Error('ORDER_ALREADY_USED');
 const now=BigInt(block.timestamp);
 if(now+1n>=closeTime)throw new Error('SALE_CLOSED');
 if(balance<q.paidUSDT)throw new Error('INSUFFICIENT_USDT');
 const [inventory,cap,sold,reserved,reservedTokens,active]=await Promise.all([token.balanceOf(saleAddress),sale.roundCapsLots(q.round),sale.soldLots(q.round),sale.reservedLots(q.round),sale.reservedHRP(),sale.activeExternal(wallet)]);
 if(active!==ZeroHash)throw new Error('EXTERNAL_ORDER_ACTIVE');
 if(inventory<q.totalHRP+reservedTokens)throw new Error('INSUFFICIENT_HRP');
 if(sold+reserved+lots>cap)throw new Error('ROUND_CAP');
 let deadline=now+BigInt(ttlSeconds)<closeTime?now+BigInt(ttlSeconds):closeTime-1n;
 if(permit){
  const a=permit.authorization;
  const [signer,revision,blocked]=await Promise.all([sale.admissionSigner(),sale.admissionRevision(),sale.admissionBlocked(wallet)]);
  if(blocked||getAddress(signer)===ZeroAddress||getAddress(a.buyer)!==wallet||BigInt(a.lots)!==lots
   ||BigInt(a.expectedRound)!==q.round||a.orderId.toLowerCase()!==orderId.toLowerCase()
   ||BigInt(a.minHRPOut)!==q.totalHRP||BigInt(a.revision)!==revision
   ||BigInt(a.deadline)<=now||BigInt(a.deadline)>now+600n||BigInt(a.deadline)>=closeTime
   ||getAddress(verifyTypedData(admissionDomain(deployment),admissionTypes,a,permit.signature))!==getAddress(signer))
   throw Error('INVALID_AUTHORIZATION');
  deadline=BigInt(a.deadline);
 }
 const approvals=[];
 if(allowance<q.paidUSDT){
  // Some USDT implementations require clearing a nonzero allowance first.
  if(allowance!==0n)approvals.push(await payment.approve.populateTransaction(saleAddress,0n));
  approvals.push(await payment.approve.populateTransaction(saleAddress,q.paidUSDT));
 }
 const purchase=permit?await sale.buyAuthorized.populateTransaction(permit.authorization,permit.signature):await sale.buy.populateTransaction(lots,q.round,orderId,deadline,q.totalHRP);
 const request=t=>({...t,from:wallet,chainId:network.chainId,value:0n});
 return {wallet,round:q.round,paidUSDT:q.paidUSDT,paidHRP:q.paidHRP,bonusHRP:q.bonusHRP,totalHRP:q.totalHRP,
  deadline,approvals:approvals.map(request),purchase:request(purchase)};
}
export function readPurchaseReceipt({receipt,deployment,buyer,orderId}) {
 if(Number(receipt.status)!==1||!receipt.to||getAddress(receipt.to)!==address(deployment.saleAddress))
  throw new Error('NOT_A_SUCCESSFUL_PURCHASE');
 const iface=new Interface(saleAbi);
 const events=receipt.logs.filter(log=>getAddress(log.address)===address(deployment.saleAddress))
  .map(log=>{try{return iface.parseLog(log)}catch{return null}})
  .filter(log=>log?.name==='Purchased'&&getAddress(log.args.buyer)===address(buyer)&&log.args.orderId===orderId);
 if(events.length!==1)throw new Error('PURCHASE_EVENT_MISSING_OR_AMBIGUOUS');
 const a=events[0].args;
 return {buyer:a.buyer,orderId:a.orderId,round:a.round,lots:a.lots,paidUSDT:a.paidUSDT,paidHRP:a.paidHRP,bonusHRP:a.bonusHRP};
}
