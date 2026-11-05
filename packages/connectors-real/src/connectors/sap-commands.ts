import { commerceMinorAmount } from '@journeyax/shared-types';
import { ToolError, type Env, type Rec, type ToolExecutionContext, type ToolSpec } from '../types';
import { SapODataClient, sapService } from './sap-odata';

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new ToolError('invalid_arguments', `An explicit valid ${label} is required.`);
  return value;
};
const decimal = (value: unknown, label: string) => { const result = text(value, label, 16); if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(result) || Number(result) <= 0 || Number(result) > 1_000_000) throw new ToolError('invalid_arguments', `A positive bounded decimal ${label} is required.`); return result; };
const idSchema = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const decimalSchema = { type: 'string', pattern: '^\\d{1,9}(?:\\.\\d{1,3})?$', maxLength: 16 };
function grant(execution?: ToolExecutionContext) {
  if (!execution?.actionId || !execution.tenantId || !execution.environmentId || !execution.principalId || !execution.releaseChecksum) throw new ToolError('not_authorised', 'A verified exact SAP command approval is required.');
}
function exact(row: Rec, expected: Rec) { return Object.entries(expected).every(([key, value]) => row[key] === value); }
async function matches(client: SapODataClient, service: string, entity: string, keys: Rec, fields: string[]): Promise<Rec[]> {
  return (await client.list(service, entity, { fields, predicates: Object.entries(keys).map(([field,value]) => ({ field, value:String(value) })), limit:2 })).records;
}

/** Native writes are deliberately small and typed. Organisational/unit/customer
 * mappings are supplied explicitly and reviewed; the model cannot send raw SAP
 * payloads, post accounting entries or turn an uncertain response into a retry. */
export function sapCommandTools(env: Env, client: SapODataClient): ToolSpec[] {
  return [
    {
      name:'create_product', readOnly:false, staffOnly:true,
      description:'Create an explicitly reviewed SAP material master with an exact external product ID, SAP product type, industry sector, base unit and source description. Never guesses classification or updates an existing product. Replays reconcile exact source fields.',
      inputSchema:{ type:'object',additionalProperties:false,required:['productId','productType','industrySector','baseUnit','description','language'],properties:{ productId:idSchema(40),productType:idSchema(4),industrySector:idSchema(1),baseUnit:idSchema(3),description:idSchema(40),language:idSchema(2) } },
      async run(args,execution) {
        grant(execution); const service=sapService(env,'PRODUCT');
        const expected={Product:text(args.productId,'SAP product ID',40),ProductType:text(args.productType,'SAP product type',4),IndustrySector:text(args.industrySector,'industry sector',1),BaseUnit:text(args.baseUnit,'base unit',3)};
        const description={Language:text(args.language,'description language',2),ProductDescription:text(args.description,'product description',40)};
        const read=async()=>{
          const records=await matches(client,service,'A_Product',{Product:expected.Product},Object.keys(expected));
          if(!records.length)return undefined;
          if(records.length!==1||!exact(records[0],expected))throw new ToolError('conflict','The SAP product already exists with different reviewed fields; no update was attempted.');
          const descriptions=await matches(client,service,'A_ProductDescription',{Product:expected.Product,Language:description.Language},['Product','Language','ProductDescription']);
          if(descriptions.length!==1||descriptions[0].ProductDescription!==description.ProductDescription)throw new ToolError('conflict','The source product description differs; no existing product was overwritten.');
          return {record:{productId:expected.Product,productType:expected.ProductType,industrySector:expected.IndustrySector,baseUnit:expected.BaseUnit,description:description.ProductDescription,language:description.Language},source:'sap-s4hana',sample:false};
        };
        const prior=await read();if(prior)return{...prior,created:false,reconciled:true};
        // SAP KBA2878248 requires the parent Product key on every deep child;
        // omitting it is rejected as multiple products in one change set.
        try {await client.create(service,'A_Product',{...expected,to_Description:{results:[{Product:expected.Product,...description}]}});}
        catch(error){try{const receipt=await read();if(receipt)return{...receipt,created:true,reconciled:true};}catch{}throw error;}
        const receipt=await read();if(!receipt)throw new ToolError('receipt_unavailable','SAP product creation has no verified source readback. Reconcile the action before retrying.');
        return{...receipt,created:true};
      },
    },
    {
      name:'create_sales_order',readOnly:false,staffOnly:true,
      description:'Create one explicitly approved SAP sales order with exact source sold-to, sales area, document type, currency, external customer reference and material quantities. ERP calculates its own price. Returns native source totals and an explicit quote-parity flag; it never claims payment, fulfilment or CRM sync. Existing matching source references are reconciled, never blindly recreated.',
      inputSchema:{type:'object',additionalProperties:false,required:['customerReference','customerId','orderType','salesOrganization','distributionChannel','division','currency','expectedNetAmount','items'],properties:{customerReference:idSchema(35),customerId:idSchema(10),orderType:idSchema(4),salesOrganization:idSchema(4),distributionChannel:idSchema(2),division:idSchema(2),currency:{type:'string',pattern:'^[A-Z]{3}$'},expectedNetAmount:{type:'number',minimum:0},referenceDocument:idSchema(10),items:{type:'array',minItems:1,maxItems:50,items:{type:'object',additionalProperties:false,required:['productId','quantity','unit'],properties:{productId:idSchema(40),quantity:decimalSchema,unit:idSchema(3)}}}}},
      async run(args,execution){
        grant(execution);const service=sapService(env,'ORDER');
        const expected={PurchaseOrderByCustomer:text(args.customerReference,'customer order reference',35),SoldToParty:text(args.customerId,'SAP sold-to ID',10),SalesOrderType:text(args.orderType,'sales order type',4),SalesOrganization:text(args.salesOrganization,'sales organisation',4),DistributionChannel:text(args.distributionChannel,'distribution channel',2),OrganizationDivision:text(args.division,'division',2),TransactionCurrency:text(args.currency,'currency',3),...(args.referenceDocument!==undefined?{ReferenceSDDocument:text(args.referenceDocument,'reference sales document',10)}:{})};
        if(!/^[A-Z]{3}$/.test(expected.TransactionCurrency)||!Number.isFinite(args.expectedNetAmount)||args.expectedNetAmount<0)throw new ToolError('invalid_arguments','An authoritative currency and expected net amount are required.');
        const expectedMinor=commerceMinorAmount(args.expectedNetAmount,expected.TransactionCurrency);
        if(!Array.isArray(args.items)||!args.items.length||args.items.length>50)throw new ToolError('invalid_arguments','An approved order needs 1–50 source material lines.');
        const items=args.items.map((line:Rec)=>({Material:text(line.productId,'SAP material ID',40),RequestedQuantity:decimal(line.quantity,'quantity'),RequestedQuantityUnit:text(line.unit,'SAP quantity unit',3)}));
        if(new Set(items.map((line:Rec)=>line.Material)).size!==items.length)throw new ToolError('invalid_arguments','Combine repeated source materials into distinct approved lines.');
        const read=async()=>{
          const records=await matches(client,service,'A_SalesOrder',{PurchaseOrderByCustomer:expected.PurchaseOrderByCustomer,SoldToParty:expected.SoldToParty},['SalesOrder',...Object.keys(expected),'TotalNetAmount','OverallSDProcessStatus','OverallTotalDeliveryStatus','OverallOrdReltdBillgStatus']);
          if(!records.length)return undefined;
          if(records.length!==1||!exact(records[0],expected))throw new ToolError('conflict','The SAP order reference is ambiguous or has different reviewed header fields. No duplicate was created.');
          const row=records[0];const lines=await client.list(service,'A_SalesOrderItem',{fields:['SalesOrder','Material','RequestedQuantity','RequestedQuantityUnit'],predicates:[{field:'SalesOrder',value:row.SalesOrder}],limit:50});
          if(lines.more||lines.records.length!==items.length||!items.every((item:Rec)=>lines.records.some(actual=>actual.Material===item.Material&&Number(actual.RequestedQuantity)===Number(item.RequestedQuantity)&&actual.RequestedQuantityUnit===item.RequestedQuantityUnit)))throw new ToolError('conflict','The SAP order reference has different source lines. No duplicate was created.');
          const nativeNet=Number(row.TotalNetAmount);if(!Number.isFinite(nativeNet)||nativeNet<0)throw new ToolError('receipt_unavailable','SAP did not confirm its native order amount.');
          return{record:{orderId:row.SalesOrder,orderNumber:row.SalesOrder,customerReference:row.PurchaseOrderByCustomer,customerId:row.SoldToParty,currency:row.TransactionCurrency,netAmount:row.TotalNetAmount,processStatus:row.OverallSDProcessStatus,deliveryStatus:row.OverallTotalDeliveryStatus,billingStatus:row.OverallOrdReltdBillgStatus},quoteParity:{matches:commerceMinorAmount(nativeNet,row.TransactionCurrency)===expectedMinor,expectedNetAmount:args.expectedNetAmount,sourceNetAmount:row.TotalNetAmount,currency:row.TransactionCurrency},source:'sap-s4hana',sample:false};
        };
        const prior=await read();if(prior)return{...prior,created:false,reconciled:true};
        const body={...expected,to_Item:items};
        try{await client.create(service,'A_SalesOrder',body);}catch(error){try{const receipt=await read();if(receipt)return{...receipt,created:true,reconciled:true};}catch{}throw error;}
        const receipt=await read();if(!receipt)throw new ToolError('receipt_unavailable','SAP order creation has no verified source receipt. Reconcile before retrying.');
        return{...receipt,created:true};
      },
    },
  ];
}
