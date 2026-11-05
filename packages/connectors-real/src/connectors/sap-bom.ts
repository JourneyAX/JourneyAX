import { ToolError, type Env, type Rec, type ToolExecutionContext, type ToolSpec } from '../types';
import { SapODataClient, sapService } from './sap-odata';
const requiredText=(value:unknown,label:string,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))throw new ToolError('invalid_arguments',`An explicit ${label} is required.`);return value;};
const quantity=(value:unknown)=>{const result=requiredText(value,'bounded decimal quantity',16);if(!/^\d{1,9}(?:\.\d{1,3})?$/.test(result)||Number(result)<=0||Number(result)>1_000_000)throw new ToolError('invalid_arguments','A positive bounded BOM quantity is required.');return result;};
const keySchema=(maxLength:number)=>({type:'string',minLength:1,maxLength});
const quantitySchema={type:'string',pattern:'^\\d{1,9}(?:\\.\\d{1,3})?$',maxLength:16};
const headerFields=['BillOfMaterial','BillOfMaterialCategory','BillOfMaterialVariant','BillOfMaterialVariantUsage','Material','Plant','BOMHeaderBaseUnit','BOMHeaderQuantityInBaseUnit','BOMHeaderText','BillOfMaterialStatus','HeaderValidityStartDate'];
const itemFields=['BillOfMaterial','Material','Plant','BillOfMaterialItemNumber','BillOfMaterialComponent','BillOfMaterialItemCategory','BillOfMaterialItemQuantity','BillOfMaterialItemUnit'];
const date=(value:unknown)=>{const day=requiredText(value,'ISO validity date',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw new ToolError('invalid_arguments','An actual ISO calendar date is required.');return day;};
const sourceDate=(value:unknown)=>{const raw=String(value),match=/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(raw),parsed=match?Number(match[1]):Date.parse(raw);return Number.isFinite(parsed)?new Date(parsed).toISOString().slice(0,10):undefined;};

/** Material BOM V2 native contract, verified against service metadata. Creation
 * remains unavailable until its tenant API authorises reads and an actual human
 * has supplied the material/plant/usage/components. No demo assembly is authored. */
export function sapBomCommandTool(env:Env,client:SapODataClient):ToolSpec {
  return{name:'create_bill_of_material',readOnly:false,staffOnly:true,
    description:'Create one exactly reviewed native SAP material BOM. Requires source material, plant, BOM usage/alternative/status, validity date and explicit component numbers/quantities/units/categories. Never invents a component relationship. Source readback reconciles header and every item; no price, compatibility or finance claim is implied.',
    inputSchema:{type:'object',additionalProperties:false,required:['productId','plant','usage','alternative','status','baseUnit','baseQuantity','validFrom','description','components'],properties:{productId:keySchema(40),plant:keySchema(4),usage:keySchema(1),alternative:keySchema(2),status:keySchema(2),baseUnit:keySchema(3),baseQuantity:quantitySchema,validFrom:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},description:keySchema(40),components:{type:'array',minItems:1,maxItems:50,items:{type:'object',additionalProperties:false,required:['itemNumber','productId','quantity','unit','category'],properties:{itemNumber:{type:'string',pattern:'^\\d{4}$'},productId:keySchema(40),quantity:quantitySchema,unit:keySchema(3),category:keySchema(1)}}}}},
    async run(args:Rec,execution?:ToolExecutionContext){
      if(!execution?.actionId||!execution.tenantId||!execution.environmentId||!execution.principalId||!execution.releaseChecksum)throw new ToolError('not_authorised','An exact verified SAP BOM approval is required.');
      const service=sapService(env,'BOM'),validFrom=date(args.validFrom);
      const expected={Material:requiredText(args.productId,'SAP parent material',40),Plant:requiredText(args.plant,'SAP plant',4),BillOfMaterialVariantUsage:requiredText(args.usage,'BOM usage',1),BillOfMaterialVariant:requiredText(args.alternative,'BOM alternative',2),BillOfMaterialStatus:requiredText(args.status,'BOM status',2),BOMHeaderBaseUnit:requiredText(args.baseUnit,'BOM base unit',3),BOMHeaderQuantityInBaseUnit:quantity(args.baseQuantity),BOMHeaderText:requiredText(args.description,'BOM description',40)};
      if(!Array.isArray(args.components)||!args.components.length||args.components.length>50)throw new ToolError('invalid_arguments','A reviewed material BOM requires 1–50 explicit components.');
      const components=args.components.map((row:Rec)=>({BillOfMaterialItemNumber:requiredText(row.itemNumber,'component item number',4),BillOfMaterialComponent:requiredText(row.productId,'component material',40),BillOfMaterialItemCategory:requiredText(row.category,'component category',1),BillOfMaterialItemQuantity:quantity(row.quantity),BillOfMaterialItemUnit:requiredText(row.unit,'component unit',3)}));
      if(components.some((row:Rec)=>!/^\d{4}$/.test(row.BillOfMaterialItemNumber))||new Set(components.map((row:Rec)=>row.BillOfMaterialItemNumber)).size!==components.length)throw new ToolError('invalid_arguments','BOM component numbers must be unique four-digit source positions.');
      const predicates=[{field:'Material',value:expected.Material},{field:'Plant',value:expected.Plant},{field:'BillOfMaterialVariantUsage',value:expected.BillOfMaterialVariantUsage},{field:'BillOfMaterialVariant',value:expected.BillOfMaterialVariant}];
      const read=async()=>{
        const headers=await client.list(service,'MaterialBOM',{fields:headerFields,predicates,limit:2});
        if(!headers.records.length)return undefined;
        const row=headers.records[0];
        if(headers.more||headers.records.length!==1||row.BillOfMaterialCategory!=='M'||sourceDate(row.HeaderValidityStartDate)!==validFrom||Object.entries(expected).some(([key,value])=>key==='BOMHeaderQuantityInBaseUnit'?Number(row[key])!==Number(value):row[key]!==value))throw new ToolError('conflict','An existing source BOM differs from the exact reviewed assembly; no duplicate or update was attempted.');
        const items=await client.list(service,'MaterialBOMItem',{fields:itemFields,predicates:[{field:'BillOfMaterial',value:row.BillOfMaterial},{field:'Material',value:expected.Material},{field:'Plant',value:expected.Plant}],limit:50});
        if(items.more||items.records.length!==components.length||!components.every((expected:Rec)=>items.records.some(actual=>Object.entries(expected).every(([key,value])=>key==='BillOfMaterialItemQuantity'?Number(actual[key])===Number(value):actual[key]===value))))throw new ToolError('conflict','The existing SAP BOM has different source components; no duplicate or overwrite was attempted.');
        return{record:{billOfMaterialId:row.BillOfMaterial,productId:row.Material,plant:row.Plant,usage:row.BillOfMaterialVariantUsage,alternative:row.BillOfMaterialVariant,status:row.BillOfMaterialStatus,baseUnit:row.BOMHeaderBaseUnit,baseQuantity:row.BOMHeaderQuantityInBaseUnit,validFrom,components:components.map((item:Rec)=>({itemNumber:item.BillOfMaterialItemNumber,productId:item.BillOfMaterialComponent,quantity:item.BillOfMaterialItemQuantity,unit:item.BillOfMaterialItemUnit,category:item.BillOfMaterialItemCategory}))},source:'sap-s4hana',sample:false};
      };
      const prior=await read();if(prior)return{...prior,created:false,reconciled:true};
      try{await client.create(service,'MaterialBOM',{...expected,BillOfMaterialCategory:'M',HeaderValidityStartDate:`/Date(${Date.parse(validFrom)})/`,to_BillOfMaterialItem:components});}catch(error){try{const receipt=await read();if(receipt)return{...receipt,created:true,reconciled:true};}catch{}throw error;}
      const receipt=await read();if(!receipt)throw new ToolError('receipt_unavailable','SAP BOM creation has no verified native header/items receipt. Reconcile before retrying.');
      return{...receipt,created:true};
    }};
}
