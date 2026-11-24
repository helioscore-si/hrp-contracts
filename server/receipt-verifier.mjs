// Read-only verifier. Never accept client-supplied receipt data or credit an internal balance here.
import {Contract,Interface,getAddress,id,isHexString} from 'ethers';
import {saleAbi,hrpAbi} from '../integration/abi.mjs';
const transfer=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const same=(a,b)=>getAddress(a)===getAddress(b);
export async function verifyPurchase({provider,deployment,txHash,boundWallet,expectedOrderId}) {
 if(!isHexString(txHash,32)||!isHexString(expectedOrderId,32))throw Error('INVALID_TRANSACTION');
 if(!Number.isSafeInteger(deployment.confirmations)||deployment.confirmations<1)throw Error('INVALID_CONFIRMATIONS');
 const network=await provider.getNetwork();if(network.chainId!==BigInt(deployment.chainId))throw Error('WRONG_CHAIN');
 const receipt=await provider.getTransactionReceipt(txHash);
 if(!receipt)return {status:'pending',txHash};
 if(Number(receipt.status)!==1)return {status:'failed',txHash};
 const transaction=await provider.getTransaction(txHash);
 if(!transaction||!transaction.to||!same(transaction.to,deployment.saleAddress))throw Error('TRANSACTION_OWNER_MISMATCH');
 if(!receipt.to||!same(receipt.to,deployment.saleAddress))throw Error('NOT_PURCHASE');
 const sale=new Contract(deployment.saleAddress,saleAbi,provider);
 const token=new Contract(deployment.tokenAddress,hrpAbi,provider);
 const [actualToken,actualPayment,boundSale,block,head]=await Promise.all([
  sale.token(),sale.paymentToken(),token.sale(),provider.getBlock(receipt.blockNumber),provider.getBlockNumber()]);
 if(!same(actualToken,deployment.tokenAddress)||!same(actualPayment,deployment.paymentTokenAddress)||!same(boundSale,deployment.saleAddress))throw Error('DEPLOYMENT_ADDRESS_MISMATCH');
 if(!block||block.hash!==receipt.blockHash)return {status:'pending',reason:'reorg',txHash};
 const confirmations=head-receipt.blockNumber+1;
 if(confirmations<deployment.confirmations)return {status:'confirming',confirmations,required:deployment.confirmations,txHash};
 const iface=new Interface(saleAbi),call=iface.parseTransaction(transaction);
 const external=call?.name==='settleExternal';
 const purchaseArgs=call?.name==='buyAuthorized'?call.args.a:call?.args;
 if(!['buy','buyAuthorized','settleExternal'].includes(call?.name)||purchaseArgs.orderId!==expectedOrderId)throw Error('ORDER_MISMATCH');
 if(!external&&!same(transaction.from,boundWallet))throw Error('TRANSACTION_OWNER_MISMATCH');
 const purchases=receipt.logs.filter(l=>same(l.address,deployment.saleAddress)).flatMap(l=>{
  try{const event=iface.parseLog(l);return event?.name==='Purchased'?[{event,log:l}]:[]}catch{return []}
 });
 if(purchases.length!==1)throw Error('PURCHASE_EVENT_MISSING');
 const {event,log}=purchases[0],a=event.args;
 if(!same(a.buyer,boundWallet)||a.orderId!==expectedOrderId||(!external&&(a.lots!==purchaseArgs.lots||a.round!==purchaseArgs.expectedRound)))throw Error('PURCHASE_EVENT_MISMATCH');
 // The destination is recorded in this transaction, so later changes (even within
 // the same block) cannot invalidate a historic purchase.
 const routes=receipt.logs.filter(l=>same(l.address,deployment.saleAddress)).flatMap(l=>{
  try{const e=iface.parseLog(l);return e?.name==='PaymentRouted'?[e.args]:[]}catch{return []}
 });
 if(!external&&routes.length!==1)throw Error('PAYMENT_ROUTE_MISSING');
 let sourcePayment=null;
 if(external){
  const externalEvents=receipt.logs.filter(l=>same(l.address,deployment.saleAddress)).flatMap(l=>{try{const e=iface.parseLog(l);return e?.name==='ExternalSettled'?[e.args]:[]}catch{return []}});
  if(externalEvents.length!==1||routes.length)throw Error('PAYMENT_ROUTE_MISMATCH');
  const e=externalEvents[0];
  if(e.orderId!==a.orderId||e.sourceTx!==call.args.sourceTx||e.logIndex!==call.args.logIndex||e.paidAt!==call.args.paidAt||![1n,2n].includes(e.source))throw Error('PAYMENT_ROUTE_MISMATCH');
  sourcePayment={network:e.source===1n?'ERC20':'TRC20',txHash:e.sourceTx,logIndex:Number(e.logIndex),micros:e.sourceMicros.toString(),recipientHash:e.recipientHash,paidAt:Number(e.paidAt),paymentId:e.paymentId};
 }
 const route=external?{buyer:a.buyer,orderId:a.orderId,paidUSDT:a.paidUSDT,treasury:null,revision:null}:routes[0];
 if(!same(route.buyer,boundWallet)||route.orderId!==a.orderId||route.paidUSDT!==a.paidUSDT)throw Error('PAYMENT_ROUTE_MISMATCH');
 const treasury=route.treasury;
 const sum=(address,from,to)=>receipt.logs.filter(l=>same(l.address,address)).reduce((n,l)=>{
  try{const e=transfer.parseLog(l);return e&&same(e.args.from,from)&&same(e.args.to,to)?n+e.args.value:n}catch{return n}
 },0n);
 if((!external&&sum(deployment.paymentTokenAddress,boundWallet,treasury)!==a.paidUSDT)
  ||sum(deployment.tokenAddress,deployment.saleAddress,boundWallet)!==a.paidHRP+a.bonusHRP)throw Error('TRANSFER_MISMATCH');
 return {status:'confirmed',txHash,chainId:deployment.chainId,buyer:getAddress(a.buyer),orderId:a.orderId,treasury:treasury?getAddress(treasury):null,treasuryRevision:route.revision?.toString()??null,...(external?{sourcePayment}:{}),
  round:Number(a.round),lots:a.lots.toString(),paidUSDT:a.paidUSDT.toString(),paidHRP:a.paidHRP.toString(),bonusHRP:a.bonusHRP.toString(),
  blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,logIndex:log.index,confirmations,timestamp:block.timestamp};
}
export async function findPurchaseHash({provider,deployment,boundWallet,orderId}) {
 if(!Number.isSafeInteger(deployment.fromBlock)||deployment.fromBlock<0||!isHexString(orderId,32))throw Error('INVALID_LOOKUP');
 // Production needs a bounded indexer. This scan is explicitly capped at 5000 blocks.
 const head=await provider.getBlockNumber();if(head-deployment.fromBlock>5000)throw Error('INDEXER_REQUIRED');
 const iface=new Interface(saleAbi);
 const topics=iface.encodeFilterTopics('Purchased',[boundWallet,orderId]);
 const logs=await provider.getLogs({address:deployment.saleAddress,fromBlock:deployment.fromBlock,toBlock:head,topics});
 if(logs.length>1)throw Error('AMBIGUOUS_ORDER');
 return logs[0]?.transactionHash??null;
}
