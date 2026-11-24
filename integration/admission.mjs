// Shared schema. Chain, sale, buyer, exact quote, order and revision are signed.
export const admissionTypes={PurchaseAuthorization:[
 {name:'buyer',type:'address'},{name:'lots',type:'uint256'},
 {name:'expectedRound',type:'uint8'},{name:'orderId',type:'bytes32'},
 {name:'deadline',type:'uint64'},{name:'minHRPOut',type:'uint256'},
 {name:'revision',type:'uint256'}
]};
export const admissionDomain=deployment=>({name:'HELIOS TokenSale',version:'1',chainId:deployment.chainId,verifyingContract:deployment.saleAddress});
