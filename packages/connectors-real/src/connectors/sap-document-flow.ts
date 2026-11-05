import { ToolError,type Env,type ToolSpec } from '../types';
import { SapODataClient,sapService } from './sap-odata';

const id=(value:unknown,label:string)=>{if(typeof value!=='string'||!value.trim()||value.length>10||/[\x00-\x1f]/.test(value))throw new ToolError('invalid_arguments',`An exact ${label} is required.`);return value;};
const identifier={type:'string',minLength:1,maxLength:10};
export function sapDocumentFlowTools(env:Env,client:SapODataClient):ToolSpec[]{
  return[
    {name:'get_order_document_flow',staffOnly:true,readOnly:true,
      description:'Read bounded native subsequent-document relationships for one exact SAP sales order. Preserves document IDs/categories and source process status. An empty result means no exposed source relationship; never invents invoice, delivery, payment or finance status.',
      inputSchema:{type:'object',additionalProperties:false,required:['orderId'],properties:{orderId:identifier}},
      async run(args){const found=await client.list(sapService(env,'ORDER'),'A_SalesOrderSubsqntProcFlow',{fields:['SalesOrder','DocRelationshipUUID','SubsequentDocument','SubsequentDocumentCategory','ProcessFlowLevel','OverallSDProcessStatus','CreationDate','LastChangeDate'],predicates:[{field:'SalesOrder',value:id(args.orderId,'SAP order ID')}],limit:50});return{records:found.records,returned:found.records.length,more:found.more,source:'sap-s4hana',sample:false};}},
    {name:'get_delivery',staffOnly:true,readOnly:true,
      description:'Read one exact native SAP outbound delivery and source status codes, dates and bill-of-lading reference. Does not turn missing/empty status into delivered, payment, consignment tracking or invoice success. No goods issue/posting operation exists in this tool.',
      inputSchema:{type:'object',additionalProperties:false,required:['deliveryId'],properties:{deliveryId:identifier}},
      async run(args){
        const found=await client.list(sapService(env,'DELIVERY'),'A_OutbDeliveryHeader',{fields:['DeliveryDocument','SoldToParty','ShipToParty','SalesOrganization','ShippingPoint','DeliveryDate','PlannedGoodsIssueDate','ActualGoodsMovementDate','OverallSDProcessStatus','OverallGoodsMovementStatus','OverallPickingStatus','OverallProofOfDeliveryStatus','OverallDelivReltdBillgStatus','BillOfLading'],predicates:[{field:'DeliveryDocument',value:id(args.deliveryId,'SAP delivery ID')}],limit:2});
        if(!found.records.length)throw new ToolError('not_found','No exact SAP outbound delivery exists.');
        if(found.more||found.records.length!==1)throw new ToolError('ambiguous','SAP returned an ambiguous delivery reference.');
        return{record:found.records[0],source:'sap-s4hana',sample:false};
      }},
    {name:'get_delivery_items',staffOnly:true,readOnly:true,
      description:'Read bounded native lines for one exact SAP outbound delivery, retaining source reference order/item, material, quantity, unit and movement/picking/proof status. No simulated consignment or installation facts.',
      inputSchema:{type:'object',additionalProperties:false,required:['deliveryId'],properties:{deliveryId:identifier}},
      async run(args){const found=await client.list(sapService(env,'DELIVERY'),'A_OutbDeliveryItem',{fields:['DeliveryDocument','DeliveryDocumentItem','ReferenceSDDocument','ReferenceSDDocumentItem','Material','Plant','ActualDeliveryQuantity','DeliveryQuantityUnit','GoodsMovementStatus','PickingStatus','ProofOfDeliveryStatus'],predicates:[{field:'DeliveryDocument',value:id(args.deliveryId,'SAP delivery ID')}],limit:50});return{records:found.records,returned:found.records.length,more:found.more,source:'sap-s4hana',sample:false};}},
  ];
}
